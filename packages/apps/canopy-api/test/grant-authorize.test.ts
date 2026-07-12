/**
 * grantAuthorize unit tests (plan-0025): authorization is purely cryptographic
 * (receipt MMR inclusion + signature against the owner-log receipt authority) and
 * makes NO SequencingQueue Durable Object call.
 *
 * The "rejects a receipt that proves a different grant" case is the security gate:
 * it proves the receipt→grant binding is load-bearing, so the previously redundant
 * queue inclusion check was safe to remove.
 */

import { encodeSigStructure, type ParsedVerifyKey } from "@forestrie/encoding";
import { encodeCborDeterministic } from "@forestrie/encoding";
import { beforeAll, describe, expect, it } from "vitest";

import { grantAuthorize } from "../src/scrapi/auth-grant.js";
import type { Grant } from "../src/grant/grant.js";
import type { GrantResult } from "../src/grant/grant-result.js";
import { grantCommitmentHashFromGrant } from "../src/grant/grant-commitment.js";
import { univocityLeafHash } from "../src/grant/leaf-commitment.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";

let signer: CryptoKeyPair;

beforeAll(async () => {
  signer = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
});

const IDTIMESTAMP = new Uint8Array(8).fill(7);

function grantWithData(grantData: Uint8Array): Grant {
  return {
    logId: uuidToBytes("550e8400-e29b-41d4-a716-446655440000"),
    ownerLogId: uuidToBytes("660e8400-e29b-41d4-a716-446655440001"),
    grant: new Uint8Array(8),
    maxHeight: 0,
    minGrowth: 0,
    grantData,
  };
}

/**
 * Build a single-leaf receipt: the COSE Sign1 payload is the MMR peak (== leaf hash
 * for a single-leaf MMR), signed by `priv`. Inclusion proof is the empty path.
 */
async function buildReceiptForGrant(
  grant: Grant,
  priv: CryptoKey,
): Promise<{ coseSign1Bytes: Uint8Array; explicitPeak: Uint8Array }> {
  const inner = await grantCommitmentHashFromGrant(grant);
  const leafHash = await univocityLeafHash(IDTIMESTAMP, inner);
  const peak = leafHash; // empty-path single-leaf MMR: root == leaf

  const protectedInner = encodeCborDeterministic(new Map([[1, -7]]));
  const sigStructure = encodeSigStructure(
    protectedInner,
    new Uint8Array(0),
    peak,
  );
  const sigBuf = (await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    priv,
    sigStructure.buffer.slice(
      sigStructure.byteOffset,
      sigStructure.byteOffset + sigStructure.byteLength,
    ) as ArrayBuffer,
  )) as ArrayBuffer;
  const sig = new Uint8Array(sigBuf);
  const coseSign1Bytes = new Uint8Array(
    encodeCborDeterministic([
      protectedInner,
      new Map<number, unknown>(),
      peak,
      sig,
    ]),
  );
  return { coseSign1Bytes, explicitPeak: peak };
}

function grantResultFor(
  grant: Grant,
  receipt: { coseSign1Bytes: Uint8Array; explicitPeak: Uint8Array } | undefined,
): GrantResult {
  return {
    grant,
    idtimestamp: IDTIMESTAMP,
    receipt: receipt
      ? {
          coseSign1Bytes: receipt.coseSign1Bytes,
          explicitPeak: receipt.explicitPeak,
          proof: { path: [], mmrIndex: 0n },
        }
      : undefined,
    bytes: new Uint8Array(0),
  };
}

const resolveToSigner = () => async (): Promise<ParsedVerifyKey[]> => [
  signer.publicKey,
];

describe("grantAuthorize (receipt-only, no queue dependency)", () => {
  it("authorizes a grant with a valid receipt and makes no queue call", async () => {
    const grant = grantWithData(new Uint8Array(64).fill(0xaa));
    const receipt = await buildReceiptForGrant(grant, signer.privateKey);

    const result = await grantAuthorize(grantResultFor(grant, receipt), {
      enforceInclusion: true,
      resolveReceiptAuthority: resolveToSigner(),
    });

    expect(result).toBeNull();
  });

  it("rejects a receipt that proves a different grant/leaf (binding is load-bearing)", async () => {
    const grantA = grantWithData(new Uint8Array(64).fill(0xaa));
    const grantB = grantWithData(new Uint8Array(64).fill(0xbb));
    // Receipt is valid for grantA, but we present it to authorize grantB.
    const receiptForA = await buildReceiptForGrant(grantA, signer.privateKey);

    const result = await grantAuthorize(grantResultFor(grantB, receiptForA), {
      enforceInclusion: true,
      resolveReceiptAuthority: resolveToSigner(),
    });

    expect(result).not.toBeNull();
    expect((result as Response).status).toBe(403);
  });

  it("skips authorization when enforceInclusion is false (pool-test escape hatch)", async () => {
    const grant = grantWithData(new Uint8Array(64).fill(0xaa));
    const result = await grantAuthorize(grantResultFor(grant, undefined), {
      enforceInclusion: false,
    });
    expect(result).toBeNull();
  });

  it("rejects (403) when enforced and the receipt is missing", async () => {
    const grant = grantWithData(new Uint8Array(64).fill(0xaa));
    const result = await grantAuthorize(grantResultFor(grant, undefined), {
      enforceInclusion: true,
      resolveReceiptAuthority: resolveToSigner(),
    });
    expect(result).not.toBeNull();
    expect((result as Response).status).toBe(403);
  });

  it("returns 503 when enforced but no receipt authority resolver is configured", async () => {
    const grant = grantWithData(new Uint8Array(64).fill(0xaa));
    const receipt = await buildReceiptForGrant(grant, signer.privateKey);
    const result = await grantAuthorize(grantResultFor(grant, receipt), {
      enforceInclusion: true,
    });
    expect(result).not.toBeNull();
    expect((result as Response).status).toBe(503);
  });
});
