/**
 * Receipt inclusion from parsed grant: COSE Sign1 must match trust anchor before MMR.
 */

import { encodeSigStructure } from "@canopy/encoding";
import { encode } from "cbor-x";
import { beforeAll, describe, expect, it } from "vitest";

import type { Grant } from "../src/grant/grant.js";
import { verifyReceiptInclusionFromParsed } from "../src/grant/receipt-verify.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";
import type { Proof } from "@canopy/merklelog";

let signerA: CryptoKeyPair;
let signerB: CryptoKeyPair;

beforeAll(async () => {
  signerA = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  signerB = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
});

async function detachedEs256Sign1(priv: CryptoKey): Promise<Uint8Array> {
  const protectedInner = new Uint8Array(encode(new Map([[1, -7]])));
  const sigStructure = encodeSigStructure(
    protectedInner,
    new Uint8Array(0),
    new Uint8Array(0),
  );
  const sigBuf = (await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    priv,
    sigStructure.buffer.slice(
      sigStructure.byteOffset,
      sigStructure.byteOffset + sigStructure.byteLength,
    ) as ArrayBuffer,
  )) as ArrayBuffer;
  const sig64 = new Uint8Array(sigBuf);
  return new Uint8Array(
    encode([protectedInner, new Map<number, unknown>(), null, sig64]),
  );
}

function minimalGrant(): Grant {
  return {
    logId: uuidToBytes("550e8400-e29b-41d4-a716-446655440000"),
    ownerLogId: uuidToBytes("660e8400-e29b-41d4-a716-446655440001"),
    grant: new Uint8Array(8),
    maxHeight: 0,
    minGrowth: 0,
    grantData: new Uint8Array(0),
  };
}

describe("verifyReceiptInclusionFromParsed + receipt COSE", () => {
  it("returns false when receipt Sign1 key does not match trust anchor", async () => {
    const receiptBytes = await detachedEs256Sign1(signerA.privateKey);
    const grant = minimalGrant();
    const junkProof: Proof = { path: [], mmrIndex: 0n };

    const ok = await verifyReceiptInclusionFromParsed(
      grant,
      new Uint8Array(8),
      null,
      junkProof,
      {
        receiptCoseBytes: receiptBytes,
        receiptVerifyKey: signerB.publicKey,
      },
    );
    expect(ok).toBe(false);
  });

  it("returns false after COSE passes when explicit peak does not match proof", async () => {
    const receiptBytes = await detachedEs256Sign1(signerA.privateKey);
    const grant = minimalGrant();
    const proof: Proof = { path: [], mmrIndex: 0n };
    const wrongPeak = new Uint8Array(32).fill(0xfe);

    const ok = await verifyReceiptInclusionFromParsed(
      grant,
      new Uint8Array(8),
      wrongPeak,
      proof,
      {
        receiptCoseBytes: receiptBytes,
        receiptVerifyKey: signerA.publicKey,
      },
    );
    expect(ok).toBe(false);
  });
});
