/**
 * KS256 round-trip tests — EOA ecrecover path and ERC-1271 hook delegation
 * when the root address has contract code (delegation-coordinator RPC path).
 */

import { describe, expect, it } from "vitest";
import {
  buildDelegationCertificateKs256,
  verifyDelegationCertificateKs256,
} from "../src/index.js";
import { encodeIntKeyCbor } from "../src/encode-int-map.js";
import {
  COSE_CRV,
  COSE_CRV_P256,
  COSE_KTY,
  COSE_KTY_EC2,
  COSE_X,
  COSE_Y,
} from "../src/payload-labels.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

/** Build a valid delegated EC2 P-256 COSE_Key CBOR blob for test inputs. */
async function generateDelegatedPublicKeyCbor(): Promise<Uint8Array> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  return encodeIntKeyCbor(
    new Map<number, unknown>([
      [COSE_KTY, COSE_KTY_EC2],
      [COSE_CRV, COSE_CRV_P256],
      [COSE_X, raw.slice(1, 33)],
      [COSE_Y, raw.slice(33, 65)],
    ]),
  );
}

describe("KS256 delegation certificate", () => {
  it("round-trips EOA assemble and verify", async () => {
    const sk = secp256k1.utils.randomPrivateKey();
    const pub = secp256k1.getPublicKey(sk, false);
    const rootSignerAddress = keccak_256(pub.slice(1)).slice(-20);
    const privateKeyHex = Buffer.from(sk).toString("hex");
    const delegatedPublicKeyCbor = await generateDelegatedPublicKeyCbor();

    const certificate = await buildDelegationCertificateKs256(
      {
        logIdHex32: "b2c3d4e5f67890ab1234567890abcdef12",
        mmrStart: 1,
        mmrEnd: 100,
        delegatedPublicKeyCbor,
        issuedAt: 1_700_000_100,
        expiresAt: 1_700_003_700,
        delegationId: new Uint8Array(16).fill(0xcd),
      },
      rootSignerAddress,
      privateKeyHex,
    );

    const verified = await verifyDelegationCertificateKs256(
      certificate,
      rootSignerAddress,
    );
    expect(verified).toBe(true);
  });

  it("uses ERC-1271 hooks when contract code is present", async () => {
    const rootSignerAddress = new Uint8Array(20).fill(0x42);
    const delegatedPublicKeyCbor = await generateDelegatedPublicKeyCbor();
    let hookCalled = false;

    const certificate = await buildDelegationCertificateKs256(
      {
        logIdHex32: "c3d4e5f67890ab1234567890abcdef1234",
        mmrStart: 0,
        mmrEnd: 10,
        delegatedPublicKeyCbor,
        issuedAt: 1_700_000_200,
        expiresAt: 1_700_003_800,
      },
      rootSignerAddress,
      Buffer.from(secp256k1.utils.randomPrivateKey()).toString("hex"),
    );

    const verified = await verifyDelegationCertificateKs256(
      certificate,
      rootSignerAddress,
      {
        hasContractCode: async () => true,
        isValidSignature: async () => {
          hookCalled = true;
          return true;
        },
      },
    );
    expect(verified).toBe(true);
    expect(hookCalled).toBe(true);
  });
});
