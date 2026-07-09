/**
 * BYOK ES256 delegation material must include the root's on-chain delegation
 * signature, uniformly with the KS256 leg (plan-2607-10): the univocity
 * contract requires an on-chain delegation proof whenever a delegated key
 * signs the checkpoint receipt, regardless of root algorithm.
 */

import { describe, expect, it } from "vitest";
import {
  decodeDelegatedCoseKeyFromBytes,
  encodeIntKeyCbor,
  normalizeEs256SignatureLowS,
  parseDelegatedCoseKeyFromPayload,
  verifyOnchainDelegationSignatureEs256,
} from "@forestrie/delegation-cose";
import {
  buildByokDelegationMaterial,
  exportEs256RootXy,
  generateEs256RootKeyPair,
} from "../src/coordinator-delegation-helpers.js";

function testDelegatedCoseKey(seed: number): Uint8Array {
  const x = new Uint8Array(32);
  const y = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    x[i] = (seed + i) & 0xff;
    y[i] = (seed + 100 + i) & 0xff;
  }
  return encodeIntKeyCbor(
    new Map<number, unknown>([
      [1, 2],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
}

describe("buildByokDelegationMaterial (ES256)", () => {
  it("includes a low-s onchainSignature verifiable against the root key", async () => {
    const rootKeyPair = await generateEs256RootKeyPair();
    const root = await exportEs256RootXy(rootKeyPair);
    const delegatedPublicKey = testDelegatedCoseKey(5);
    const logIdHex32 = "101112131415161718191a1b1c1d1e1f";

    const material = await buildByokDelegationMaterial({
      rootKeyPair,
      logIdHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
    });

    expect(material.onchainSignature).toBeDefined();
    expect(material.onchainSignature!.length).toBe(64);
    // Contract's P256 verifier rejects malleable high-s signatures.
    expect(Array.from(material.onchainSignature!)).toEqual(
      Array.from(normalizeEs256SignatureLowS(material.onchainSignature!)),
    );

    const { x, y } = parseDelegatedCoseKeyFromPayload(
      decodeDelegatedCoseKeyFromBytes(delegatedPublicKey),
    );
    const ok = await verifyOnchainDelegationSignatureEs256(
      {
        logIdHex: logIdHex32,
        mmrStart: 0,
        mmrEnd: 16383,
        delegatedKeyX: x,
        delegatedKeyY: y,
      },
      material.onchainSignature!,
      root.x,
      root.y,
    );
    expect(ok).toBe(true);
  });
});
