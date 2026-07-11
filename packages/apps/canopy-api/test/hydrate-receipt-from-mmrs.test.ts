/**
 * R2 fixture tests for buildReceiptForEntry + hydrateGrantReceiptFromMmrs (plan-0026).
 * Exercises the parent-grant hydration path used by auth-data-log-chain:
 * - (A) delegation cert copied from checkpoint label 1000
 * - (B) inclusion proof + detached peak verify through grantAuthorize
 */

import { encodeSigStructure } from "@forestrie/encoding";
import { encode as encodeCbor } from "cbor-x";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { grantAuthorize } from "../src/scrapi/auth-grant.js";
import { grantCommitmentHashFromGrant } from "../src/grant/grant-commitment.js";
import {
  extractDelegationCertBytes,
  resolveReceiptVerifyKey,
} from "../src/grant/delegation-verify.js";
import type { Grant } from "../src/grant/grant.js";
import type { GrantResult } from "../src/grant/grant-result.js";
import { univocityLeafHash } from "../src/grant/leaf-commitment.js";
import {
  parseReceipt,
  verifyReceiptInclusionFromParsed,
} from "../src/grant/receipt-verify.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";
import { importEs256PublicKeyFromGrantDataXy64 } from "../src/scrapi/custodian-grant.js";
import { buildReceiptForEntry } from "../src/scrapi/resolve-receipt.js";
import { hydrateGrantReceiptFromMmrs } from "../src/scrapi/hydrate-grant-receipt.js";
import {
  buildDelegationCert,
  generateP256KeyPair,
  peakForLeafProof,
} from "./helpers/delegated-receipt-fixtures.js";
import {
  buildPeakReceiptSlots,
  encodePeakReceiptCoseSign1,
  peakIndexForLeafProof,
  putMmrsFixture,
} from "./helpers/mmrs-r2-fixture.js";

const MASSIF_HEIGHT = 3;
const LOG_ID = "a1111111-1111-4111-8111-111111111111";
const MMR_SIZE = 3n;
const MMR_INDEX_AUTH = 1n;
const IDTIMESTAMP_BOOT = new Uint8Array(8).fill(0x01);
const IDTIMESTAMP_AUTH = new Uint8Array(8).fill(0x02);

let custodyRoot: CryptoKeyPair;
let delegated: CryptoKeyPair;
let custodyVerifyKey: CryptoKey;
let leaf0Hash: Uint8Array;
let authGrant: Grant;
let authLeafHash: Uint8Array;
let signedPeakReceipt: Uint8Array;
let delegationCert: Uint8Array;

function proveEnvHasMMRSBucket(e: unknown): asserts e is { R2_MMRS: R2Bucket } {
  if (!e || typeof e !== "object" || !("R2_MMRS" in e)) {
    throw new Error("test env missing R2_MMRS binding");
  }
}

function grantWithData(grantData: Uint8Array): Grant {
  const owner = uuidToBytes(LOG_ID);
  const g = new Uint8Array(8);
  g[3] = 0x03;
  g[7] = 0x01;
  return {
    logId: owner,
    ownerLogId: owner,
    grant: g,
    maxHeight: 0,
    minGrowth: 0,
    grantData,
  };
}

async function signPeakReceipt(
  peak: Uint8Array,
  signer: CryptoKeyPair,
): Promise<Uint8Array> {
  const protectedInner = cborBytes(new Map<number, unknown>([[1, -7]]));
  const sigStructure = encodeSigStructure(
    protectedInner,
    new Uint8Array(0),
    peak,
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signer.privateKey,
      sigStructure.buffer.slice(
        sigStructure.byteOffset,
        sigStructure.byteOffset + sigStructure.byteLength,
      ) as ArrayBuffer,
    ),
  );
  return encodePeakReceiptCoseSign1(
    protectedInner,
    new Map<number, unknown>(),
    sig,
  );
}

function cborBytes(value: unknown): Uint8Array {
  const encoded = encodeCbor(value);
  return encoded instanceof Uint8Array
    ? encoded
    : new Uint8Array(encoded as ArrayLike<number>);
}

describe("buildReceiptForEntry + hydrateGrantReceiptFromMmrs (R2_MMRS)", () => {
  beforeAll(async () => {
    proveEnvHasMMRSBucket(env);
    const bucket = env.R2_MMRS;

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
    authGrant = grantWithData(new Uint8Array(64).fill(0xbb));
    const inner0 = await grantCommitmentHashFromGrant(grant0);
    const innerAuth = await grantCommitmentHashFromGrant(authGrant);
    leaf0Hash = await univocityLeafHash(IDTIMESTAMP_BOOT, inner0);
    authLeafHash = await univocityLeafHash(IDTIMESTAMP_AUTH, innerAuth);

    const leaf2Hash = new Uint8Array(32).fill(0xcc);
    const placeholderPeak = encodePeakReceiptCoseSign1(
      new Uint8Array(),
      new Map(),
      new Uint8Array(),
    );

    await putMmrsFixture(bucket, {
      logId: LOG_ID,
      massifHeight: MASSIF_HEIGHT,
      mmrSize: MMR_SIZE,
      logHashes: [leaf0Hash, authLeafHash, leaf2Hash],
      peakReceipts: [placeholderPeak, placeholderPeak],
      delegationCert: undefined,
    });

    const draft = await buildReceiptForEntry(
      LOG_ID,
      MASSIF_HEIGHT,
      MMR_INDEX_AUTH,
      bucket,
    );
    expect(draft).not.toBeNull();
    const parsedDraft = parseReceipt(draft!);
    expect(parsedDraft.proof.mmrIndex).toBe(MMR_INDEX_AUTH);
    expect(parsedDraft.proof.path.length).toBeGreaterThan(0);

    const peak = await peakForLeafProof(authLeafHash, parsedDraft.proof);
    signedPeakReceipt = await signPeakReceipt(peak, delegated);
    const delegatedRaw = new Uint8Array(
      (await crypto.subtle.exportKey(
        "raw",
        delegated.publicKey,
      )) as ArrayBuffer,
    );
    delegationCert = await buildDelegationCert(custodyRoot, delegatedRaw);

    const pIdx = peakIndexForLeafProof(MMR_SIZE, parsedDraft.proof.path.length);
    const peakSlots = buildPeakReceiptSlots(pIdx, signedPeakReceipt);

    await putMmrsFixture(bucket, {
      logId: LOG_ID,
      massifHeight: MASSIF_HEIGHT,
      mmrSize: MMR_SIZE,
      logHashes: [leaf0Hash, authLeafHash, leaf2Hash],
      peakReceipts: peakSlots,
      delegationCert,
    });
  });

  it("buildReceiptForEntry copies delegation cert (label 1000) from checkpoint", async () => {
    proveEnvHasMMRSBucket(env);
    const rebuilt = await buildReceiptForEntry(
      LOG_ID,
      MASSIF_HEIGHT,
      MMR_INDEX_AUTH,
      env.R2_MMRS,
    );
    expect(rebuilt).not.toBeNull();
    const parsed = parseReceipt(rebuilt!);
    const cert = extractDelegationCertBytes(parsed.coseSign1[1]);
    expect(cert).not.toBeNull();
    expect(cert!.length).toBeGreaterThan(0);
    expect(cert!.length).toBe(delegationCert.length);
    expect(parsed.proof.mmrIndex).toBe(MMR_INDEX_AUTH);
    expect(parsed.explicitPeak).toBeNull();
  });

  it("buildReceiptForEntry without checkpoint cert yields no label 1000 (regression A)", async () => {
    proveEnvHasMMRSBucket(env);
    const bucket = env.R2_MMRS;
    const noCertLog = "b2222222-2222-4222-8222-222222222222";
    await putMmrsFixture(bucket, {
      logId: noCertLog,
      massifHeight: MASSIF_HEIGHT,
      mmrSize: MMR_SIZE,
      logHashes: [leaf0Hash, authLeafHash, new Uint8Array(32).fill(0xcc)],
      peakReceipts: [signedPeakReceipt],
      delegationCert: undefined,
    });

    const rebuilt = await buildReceiptForEntry(
      noCertLog,
      MASSIF_HEIGHT,
      MMR_INDEX_AUTH,
      bucket,
    );
    expect(rebuilt).not.toBeNull();
    expect(
      extractDelegationCertBytes(parseReceipt(rebuilt!).coseSign1[1]),
    ).toBeNull();
  });

  it("hydrate uses ownerLogId for child auth grant (leaf on parent MMR)", async () => {
    proveEnvHasMMRSBucket(env);
    const rootOwner = "d4444444-4444-4444-8444-444444444444";
    const childAuthLog = "c5555555-5555-4555-8555-555555555555";
    const pIdx = peakIndexForLeafProof(MMR_SIZE, 1);
    const peakSlots = buildPeakReceiptSlots(pIdx, signedPeakReceipt);
    await putMmrsFixture(env.R2_MMRS, {
      logId: rootOwner,
      massifHeight: MASSIF_HEIGHT,
      mmrSize: MMR_SIZE,
      logHashes: [leaf0Hash, authLeafHash, new Uint8Array(32).fill(0xcc)],
      peakReceipts: peakSlots,
      delegationCert,
    });

    const childAuthGrant: Grant = {
      logId: uuidToBytes(childAuthLog),
      ownerLogId: uuidToBytes(rootOwner),
      grant: authGrant.grant,
      maxHeight: 0,
      minGrowth: 0,
      grantData: authGrant.grantData,
    };
    const stale: GrantResult = {
      grant: childAuthGrant,
      idtimestamp: IDTIMESTAMP_AUTH,
      receipt: {
        coseSign1Bytes: new Uint8Array(0),
        explicitPeak: null,
        proof: { path: [], mmrIndex: MMR_INDEX_AUTH },
      },
      bytes: new Uint8Array(0),
    };
    const hydrated = await hydrateGrantReceiptFromMmrs(
      stale,
      env.R2_MMRS,
      MASSIF_HEIGHT,
    );
    expect(
      extractDelegationCertBytes(
        parseReceipt(hydrated.receipt!.coseSign1Bytes).coseSign1[1],
      ),
    ).not.toBeNull();
    const wrongTargetLogRebuild = await buildReceiptForEntry(
      childAuthLog,
      MASSIF_HEIGHT,
      MMR_INDEX_AUTH,
      env.R2_MMRS,
    );
    expect(wrongTargetLogRebuild).toBeNull();
  });

  it("hydrateGrantReceiptFromMmrs preserves cert and grantAuthorize accepts auth leaf", async () => {
    proveEnvHasMMRSBucket(env);
    const rebuilt = await buildReceiptForEntry(
      LOG_ID,
      MASSIF_HEIGHT,
      MMR_INDEX_AUTH,
      env.R2_MMRS,
    );
    expect(rebuilt).not.toBeNull();
    const parsed = parseReceipt(rebuilt!);

    const staleResult: GrantResult = {
      grant: authGrant,
      idtimestamp: IDTIMESTAMP_AUTH,
      receipt: {
        coseSign1Bytes: new Uint8Array(0),
        explicitPeak: null,
        proof: { path: [], mmrIndex: MMR_INDEX_AUTH },
      },
      bytes: new Uint8Array(0),
    };

    const hydrated = await hydrateGrantReceiptFromMmrs(
      staleResult,
      env.R2_MMRS,
      MASSIF_HEIGHT,
    );
    expect(hydrated.receipt?.coseSign1Bytes?.length).toBeGreaterThan(0);
    expect(
      extractDelegationCertBytes(
        parseReceipt(hydrated.receipt!.coseSign1Bytes).coseSign1[1],
      ),
    ).not.toBeNull();

    const resolved = await resolveReceiptVerifyKey(
      hydrated.receipt!.coseSign1Bytes,
      custodyVerifyKey,
    );
    expect(resolved?.verifyKeys.length).toBeGreaterThanOrEqual(2);

    const outcome = await verifyReceiptInclusionFromParsed(
      authGrant,
      IDTIMESTAMP_AUTH,
      hydrated.receipt!.explicitPeak ?? null,
      hydrated.receipt!.proof,
      {
        receiptCoseBytes: hydrated.receipt!.coseSign1Bytes,
        receiptVerifyKeys: resolved!.verifyKeys,
      },
    );
    expect(outcome).toBe("ok");

    const resolveReceiptAuthority = async (
      _ownerHex: string,
      receiptCoseBytes: Uint8Array,
    ) => {
      const r = await resolveReceiptVerifyKey(
        receiptCoseBytes,
        custodyVerifyKey,
      );
      return r?.verifyKeys ?? null;
    };

    const authz = await grantAuthorize(hydrated, {
      enforceInclusion: true,
      resolveReceiptAuthority,
    });
    expect(authz).toBeNull();
  });

  it("hydrate + verify fails when checkpoint omits cert (case A)", async () => {
    proveEnvHasMMRSBucket(env);
    const noCertLog = "c3333333-3333-4333-8333-333333333333";
    const draft = await buildReceiptForEntry(
      LOG_ID,
      MASSIF_HEIGHT,
      MMR_INDEX_AUTH,
      env.R2_MMRS,
    );
    const proofLen = parseReceipt(draft!).proof.path.length;
    const pIdx = peakIndexForLeafProof(MMR_SIZE, proofLen);
    const peakSlots = buildPeakReceiptSlots(pIdx, signedPeakReceipt);

    await putMmrsFixture(env.R2_MMRS, {
      logId: noCertLog,
      massifHeight: MASSIF_HEIGHT,
      mmrSize: MMR_SIZE,
      logHashes: [leaf0Hash, authLeafHash, new Uint8Array(32).fill(0xcc)],
      peakReceipts: peakSlots,
    });

    const rebuilt = await buildReceiptForEntry(
      noCertLog,
      MASSIF_HEIGHT,
      MMR_INDEX_AUTH,
      env.R2_MMRS,
    );
    expect(rebuilt).not.toBeNull();
    expect(
      extractDelegationCertBytes(parseReceipt(rebuilt!).coseSign1[1]),
    ).toBeNull();

    const grantOnNoCertLog: Grant = {
      ...authGrant,
      logId: uuidToBytes(noCertLog),
      ownerLogId: uuidToBytes(noCertLog),
    };

    const hydrated = await hydrateGrantReceiptFromMmrs(
      {
        grant: grantOnNoCertLog,
        idtimestamp: IDTIMESTAMP_AUTH,
        receipt: {
          coseSign1Bytes: rebuilt!,
          explicitPeak: null,
          proof: parseReceipt(rebuilt!).proof,
        },
        bytes: new Uint8Array(0),
      },
      env.R2_MMRS,
      MASSIF_HEIGHT,
    );

    const resolved = await resolveReceiptVerifyKey(
      hydrated.receipt!.coseSign1Bytes,
      custodyVerifyKey,
    );
    expect(resolved?.verifyKeys).toHaveLength(1);

    const outcome = await verifyReceiptInclusionFromParsed(
      grantOnNoCertLog,
      IDTIMESTAMP_AUTH,
      null,
      hydrated.receipt!.proof,
      {
        receiptCoseBytes: hydrated.receipt!.coseSign1Bytes,
        receiptVerifyKeys: resolved!.verifyKeys,
      },
    );
    expect(outcome).toBe("signature-failed");

    const resolveReceiptAuthority = async (
      _ownerHex: string,
      receiptCoseBytes: Uint8Array,
    ) => {
      const r = await resolveReceiptVerifyKey(
        receiptCoseBytes,
        custodyVerifyKey,
      );
      return r?.verifyKeys ?? null;
    };

    const authz = await grantAuthorize(
      { ...hydrated, grant: grantOnNoCertLog },
      {
        enforceInclusion: true,
        resolveReceiptAuthority,
      },
    );
    expect(authz).not.toBeNull();
    expect(authz instanceof Response).toBe(true);
    if (authz instanceof Response) {
      expect(authz.status).toBe(403);
    }
  });

  it("corrupted COSE signature fails after hydrate (case B)", async () => {
    proveEnvHasMMRSBucket(env);
    const rebuilt = await buildReceiptForEntry(
      LOG_ID,
      MASSIF_HEIGHT,
      MMR_INDEX_AUTH,
      env.R2_MMRS,
    );
    expect(rebuilt).not.toBeNull();

    const hydrated = await hydrateGrantReceiptFromMmrs(
      {
        grant: authGrant,
        idtimestamp: IDTIMESTAMP_AUTH,
        receipt: {
          coseSign1Bytes: rebuilt!,
          explicitPeak: null,
          proof: parseReceipt(rebuilt!).proof,
        },
        bytes: new Uint8Array(0),
      },
      env.R2_MMRS,
      MASSIF_HEIGHT,
    );

    const corrupted = new Uint8Array(hydrated.receipt!.coseSign1Bytes);
    corrupted[corrupted.length - 1]! ^= 0xff;

    const resolved = await resolveReceiptVerifyKey(corrupted, custodyVerifyKey);
    const outcome = await verifyReceiptInclusionFromParsed(
      authGrant,
      IDTIMESTAMP_AUTH,
      null,
      hydrated.receipt!.proof,
      {
        receiptCoseBytes: corrupted,
        receiptVerifyKeys: resolved!.verifyKeys,
      },
    );
    expect(outcome).toBe("signature-failed");
  });
});
