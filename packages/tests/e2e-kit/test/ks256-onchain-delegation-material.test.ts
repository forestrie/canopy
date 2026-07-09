/**
 * KS256 bootstrap delegation material must include the wallet's on-chain
 * delegation signature (plan-2607-10): the univocity contract requires the
 * KS256 root to sign the delegation Sig_structure in addition to the COSE
 * certificate; the coordinator returns it to the sealer as `onchainProof`.
 */

import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  decodeDelegatedCoseKeyFromBytes,
  encodeIntKeyCbor,
  parseDelegatedCoseKeyFromPayload,
  verifyOnchainDelegationSignatureKs256,
} from "@forestrie/delegation-cose";
import { buildKs256BootstrapDelegationMaterial } from "../src/coordinator-delegation-helpers.js";

// Anvil dev account 0.
const ROOT_PRIVATE_KEY_HEX =
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function rootAddress(privateKeyHex: string): Uint8Array {
  const pub = secp256k1.getPublicKey(privateKeyHex, false);
  return keccak_256(pub.slice(1)).slice(-20);
}

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

describe("buildKs256BootstrapDelegationMaterial", () => {
  it("includes an onchainSignature verifiable against the root address", async () => {
    const address = rootAddress(ROOT_PRIVATE_KEY_HEX);
    const delegatedPublicKey = testDelegatedCoseKey(3);
    const logIdHex32 = "101112131415161718191a1b1c1d1e1f";

    const material = await buildKs256BootstrapDelegationMaterial({
      rootSignerAddress: address,
      privateKeyHex: ROOT_PRIVATE_KEY_HEX,
      logIdHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
    });

    expect(material.onchainSignature).toBeDefined();
    expect(material.onchainSignature!.length).toBe(65);

    const { x, y } = parseDelegatedCoseKeyFromPayload(
      decodeDelegatedCoseKeyFromBytes(delegatedPublicKey),
    );
    const ok = await verifyOnchainDelegationSignatureKs256(
      {
        logIdHex: logIdHex32,
        mmrStart: 0,
        mmrEnd: 16383,
        delegatedKeyX: x,
        delegatedKeyY: y,
      },
      material.onchainSignature!,
      address,
    );
    expect(ok).toBe(true);
  });
});
