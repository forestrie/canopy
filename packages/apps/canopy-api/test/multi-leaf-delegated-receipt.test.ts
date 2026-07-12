/**
 * Offline reproduction for auth-data-log-chain parent grant verification:
 * delegated seal at mmrIndex > 0 (non-empty inclusion path), detached peak payload.
 *
 * Distinguishes:
 * - (A) missing delegation cert on hydrated/assembled receipt → signature-failed
 * - (B) wrong peak bytes → signature-failed
 * - happy path with cert + correct peak → ok
 */

import { importEs256PublicKeyFromGrantDataXy64 } from "../src/scrapi/custodian-grant.js";
import { grantAuthorize } from "../src/scrapi/auth-grant.js";
import type { Grant } from "../src/grant/grant.js";
import type { GrantResult } from "../src/grant/grant-result.js";
import { grantCommitmentHashFromGrant } from "../src/grant/grant-commitment.js";
import {
  extractDelegationCertBytes,
  resolveReceiptVerifyKey,
} from "../src/grant/delegation-verify.js";
import { univocityLeafHash } from "../src/grant/leaf-commitment.js";
import {
  parseReceipt,
  verifyReceiptInclusionFromParsed,
} from "../src/grant/receipt-verify.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";
import type { Proof } from "@forestrie/merklelog";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildDelegatedDetachedPeakReceipt,
  generateP256KeyPair,
  peakForLeafProof,
  positionCommittedInteriorHash,
} from "./helpers/delegated-receipt-fixtures.js";
import { inclusionProofForIndex } from "./helpers/mmr-inclusion-proof.js";

const IDTIMESTAMP_LEAF0 = new Uint8Array(8).fill(0x01);
const IDTIMESTAMP_LEAF1 = new Uint8Array(8).fill(0x02);

let custodyRoot: CryptoKeyPair;
let delegated: CryptoKeyPair;
let custodyVerifyKey: CryptoKey;

/** Two-leaf MMR: sibling leaf hashes at indices 0 and 1. */
let leaf0Hash: Uint8Array;
let leaf1Hash: Uint8Array;
let proofLeaf1: Uint8Array[];
let peakForLeaf1: Uint8Array;

beforeAll(async () => {
  custodyRoot = await generateP256KeyPair();
  delegated = await generateP256KeyPair();
  const custodyRaw = new Uint8Array(
    (await crypto.subtle.exportKey(
      "raw",
      custodyRoot.publicKey,
    )) as ArrayBuffer,
  );
  custodyVerifyKey = await importEs256PublicKeyFromGrantDataXy64(
    custodyRaw.slice(1),
  );

  const grant0 = grantWithData(new Uint8Array(64).fill(0xaa));
  const grant1 = grantWithData(new Uint8Array(64).fill(0xbb));
  const inner0 = await grantCommitmentHashFromGrant(grant0);
  const inner1 = await grantCommitmentHashFromGrant(grant1);
  leaf0Hash = await univocityLeafHash(IDTIMESTAMP_LEAF0, inner0);
  leaf1Hash = await univocityLeafHash(IDTIMESTAMP_LEAF1, inner1);

  const getHash = (i: bigint) => (i === 0n ? leaf0Hash : leaf1Hash);
  proofLeaf1 = inclusionProofForIndex(getHash, 1n, 1n);
  expect(proofLeaf1).toHaveLength(1);
  expect(proofLeaf1[0]).toEqual(leaf0Hash);

  const proof: Proof = { path: proofLeaf1, mmrIndex: 1n };
  peakForLeaf1 = await peakForLeafProof(leaf1Hash, proof);
});

function grantWithData(grantData: Uint8Array): Grant {
  const owner = uuidToBytes("660e8400-e29b-41d4-a716-446655440001");
  return {
    logId: owner,
    ownerLogId: owner,
    grant: new Uint8Array(8),
    maxHeight: 0,
    minGrowth: 0,
    grantData,
  };
}

function grantResultAtLeaf1(
  grant: Grant,
  receiptCoseBytes: Uint8Array,
  explicitPeak: Uint8Array | null,
): GrantResult {
  const parsed = parseReceipt(receiptCoseBytes);
  return {
    grant,
    idtimestamp: IDTIMESTAMP_LEAF1,
    receipt: {
      coseSign1Bytes: receiptCoseBytes,
      explicitPeak,
      proof: parsed.proof,
    },
    bytes: new Uint8Array(0),
  };
}

describe("multi-leaf delegated detached receipt (mmrIndex=1)", () => {
  it("verifies with delegation cert and correct peak (happy path)", async () => {
    const grant = grantWithData(new Uint8Array(64).fill(0xbb));
    const proof: Proof = { path: proofLeaf1, mmrIndex: 1n };
    const receipt = await buildDelegatedDetachedPeakReceipt({
      delegated,
      custodyRoot,
      peak: peakForLeaf1,
      proof,
      includeDelegationCert: true,
    });

    const resolved = await resolveReceiptVerifyKey(receipt, custodyVerifyKey);
    expect(resolved).not.toBeNull();
    expect(resolved!.verifyKeys.length).toBeGreaterThanOrEqual(2);

    const outcome = await verifyReceiptInclusionFromParsed(
      grant,
      IDTIMESTAMP_LEAF1,
      null,
      proof,
      {
        receiptCoseBytes: receipt,
        receiptVerifyKeys: resolved!.verifyKeys,
      },
    );
    expect(outcome).toBe("ok");
  });

  it("verifies a peak built the go way H(pos=3 || leaf0 || leaf1) (non-circular)", async () => {
    // Build the signed detached peak independently of calculateRoot, mirroring
    // go-merklelog / the MMR profile: interior node = H(pos_BE8 || left || right).
    // For the size-3 MMR the peak node's 1-based position is 3. This fails
    // before the position-commitment fix (calculateRoot omitted pos) and passes
    // only after it.
    const grant = grantWithData(new Uint8Array(64).fill(0xbb));
    const proof: Proof = { path: proofLeaf1, mmrIndex: 1n };
    const goPeak = await positionCommittedInteriorHash(
      3n,
      leaf0Hash,
      leaf1Hash,
    );

    // The fixture peak (via calculateRoot) must agree with the go-derived peak.
    expect(Buffer.from(peakForLeaf1).toString("hex")).toBe(
      Buffer.from(goPeak).toString("hex"),
    );

    const receipt = await buildDelegatedDetachedPeakReceipt({
      delegated,
      custodyRoot,
      peak: goPeak,
      proof,
      includeDelegationCert: true,
    });

    const resolved = await resolveReceiptVerifyKey(receipt, custodyVerifyKey);
    expect(resolved).not.toBeNull();

    const outcome = await verifyReceiptInclusionFromParsed(
      grant,
      IDTIMESTAMP_LEAF1,
      null,
      proof,
      {
        receiptCoseBytes: receipt,
        receiptVerifyKeys: resolved!.verifyKeys,
      },
    );
    expect(outcome).toBe("ok");
  });

  it("(A) fails signature when delegation cert is omitted (hydrate without cert copy)", async () => {
    const grant = grantWithData(new Uint8Array(64).fill(0xbb));
    const proof: Proof = { path: proofLeaf1, mmrIndex: 1n };
    const receipt = await buildDelegatedDetachedPeakReceipt({
      delegated,
      custodyRoot,
      peak: peakForLeaf1,
      proof,
      includeDelegationCert: false,
    });

    expect(
      extractDelegationCertBytes(parseReceipt(receipt).coseSign1[1]),
    ).toBeNull();

    const resolved = await resolveReceiptVerifyKey(receipt, custodyVerifyKey);
    expect(resolved?.verifyKeys).toEqual([custodyVerifyKey]);

    const outcome = await verifyReceiptInclusionFromParsed(
      grant,
      IDTIMESTAMP_LEAF1,
      null,
      proof,
      {
        receiptCoseBytes: receipt,
        receiptVerifyKeys: resolved!.verifyKeys,
      },
    );
    expect(outcome).toBe("signature-failed");
  });

  it("(B) fails signature when peak signed does not match inclusion proof path", async () => {
    const grant = grantWithData(new Uint8Array(64).fill(0xbb));
    const proof: Proof = { path: proofLeaf1, mmrIndex: 1n };
    const wrongPeak = new Uint8Array(32).fill(0xee);
    const receipt = await buildDelegatedDetachedPeakReceipt({
      delegated,
      custodyRoot,
      peak: wrongPeak,
      proof,
      includeDelegationCert: true,
    });

    const resolved = await resolveReceiptVerifyKey(receipt, custodyVerifyKey);
    expect(resolved).not.toBeNull();

    const outcome = await verifyReceiptInclusionFromParsed(
      grant,
      IDTIMESTAMP_LEAF1,
      null,
      proof,
      {
        receiptCoseBytes: receipt,
        receiptVerifyKeys: resolved!.verifyKeys,
      },
    );
    expect(outcome).toBe("signature-failed");
  });

  it("grantAuthorize accepts multi-leaf delegated parent grant with cert", async () => {
    const grant = grantWithData(new Uint8Array(64).fill(0xbb));
    const proof: Proof = { path: proofLeaf1, mmrIndex: 1n };
    const receipt = await buildDelegatedDetachedPeakReceipt({
      delegated,
      custodyRoot,
      peak: peakForLeaf1,
      proof,
      includeDelegationCert: true,
    });

    const resolveReceiptAuthority = async (
      _ownerLogIdLowerHex32: string,
      receiptCoseBytes: Uint8Array,
    ) => {
      const r = await resolveReceiptVerifyKey(
        receiptCoseBytes,
        custodyVerifyKey,
      );
      return r?.verifyKeys ?? null;
    };

    const result = await grantAuthorize(
      grantResultAtLeaf1(grant, receipt, null),
      {
        enforceInclusion: true,
        resolveReceiptAuthority,
      },
    );
    expect(result).toBeNull();
  });

  it("grantAuthorize rejects multi-leaf parent when delegation cert missing", async () => {
    const grant = grantWithData(new Uint8Array(64).fill(0xbb));
    const proof: Proof = { path: proofLeaf1, mmrIndex: 1n };
    const receipt = await buildDelegatedDetachedPeakReceipt({
      delegated,
      custodyRoot,
      peak: peakForLeaf1,
      proof,
      includeDelegationCert: false,
    });

    const resolveReceiptAuthority = async (
      _ownerLogIdLowerHex32: string,
      receiptCoseBytes: Uint8Array,
    ) => {
      const r = await resolveReceiptVerifyKey(
        receiptCoseBytes,
        custodyVerifyKey,
      );
      return r?.verifyKeys ?? null;
    };

    const result = await grantAuthorize(
      grantResultAtLeaf1(grant, receipt, null),
      {
        enforceInclusion: true,
        resolveReceiptAuthority,
      },
    );
    expect(result).not.toBeNull();
    expect(result instanceof Response).toBe(true);
    if (result instanceof Response) {
      expect(result.status).toBe(403);
      const body = new Uint8Array(await result.arrayBuffer());
      const text = new TextDecoder().decode(body);
      expect(text).toMatch(/signature did not verify/i);
    }
  });

  it("assembled receipt without cert matches buildReceiptForEntry omission regression", async () => {
    const proof: Proof = { path: proofLeaf1, mmrIndex: 1n };
    const withCert = await buildDelegatedDetachedPeakReceipt({
      delegated,
      custodyRoot,
      peak: peakForLeaf1,
      proof,
      includeDelegationCert: true,
    });
    const withoutCert = await buildDelegatedDetachedPeakReceipt({
      delegated,
      custodyRoot,
      peak: peakForLeaf1,
      proof,
      includeDelegationCert: false,
    });

    expect(
      extractDelegationCertBytes(parseReceipt(withCert).coseSign1[1]),
    ).not.toBeNull();
    expect(
      extractDelegationCertBytes(parseReceipt(withoutCert).coseSign1[1]),
    ).toBeNull();
    expect(parseReceipt(withoutCert).proof.mmrIndex).toBe(1n);
    expect(parseReceipt(withoutCert).proof.path).toHaveLength(1);
  });
});
