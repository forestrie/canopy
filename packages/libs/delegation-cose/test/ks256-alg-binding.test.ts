/**
 * KS256 alg binding (plan-2610-03 D6): a certificate whose protected `alg` is
 * not −65799, or that carries a WebAuthn envelope, is refused even when the
 * root's secp256k1 signature over keccak256(Sig_structure) recovers — the
 * check arbor's `verify_certificate_ks256.go` makes. Also pins
 * {@link extractKs256CertificateDigest}. Keys are generated per run.
 */

import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  COSE_ALG_ES256,
  COSE_ALG_ES256_WEBAUTHN,
  COSE_ALG_KS256,
  extractKs256CertificateDigest,
  verifyDelegationCertificateKs256,
} from "../src/index.js";
import { assembleDelegationCertificate } from "../src/assemble-certificate.js";
import {
  buildDelegationPayloadBytes,
  buildDelegationToBeSigned,
} from "../src/build-delegation-payload.js";
import { DELEGATION_CONTENT_TYPE } from "../src/delegation-content-type.js";
import { encodeIntKeyCbor } from "../src/encode-int-map.js";
import { decodeCoseSign1Parts } from "../src/parse-delegated-cose-key.js";
import {
  COSE_CRV,
  COSE_CRV_P256,
  COSE_HEADER_ALG,
  COSE_HEADER_CTY,
  COSE_HEADER_KID,
  COSE_KTY,
  COSE_KTY_EC2,
  COSE_X,
  COSE_Y,
} from "../src/payload-labels.js";

/** A fresh secp256k1 root and its 20-byte address. */
function newRoot(): { sk: Uint8Array; address: Uint8Array } {
  const sk = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(sk, false);
  return { sk, address: keccak_256(pub.slice(1)).slice(-20) };
}

/**
 * A delegation certificate with the given protected `alg`, signed KS256-style
 * (keccak256 over Sig_structure, 65-byte `r‖s‖v`) by `sk`.
 */
function signedCertificate(
  alg: number | string,
  sk: Uint8Array,
  address: Uint8Array,
): Uint8Array {
  const protectedBytes = encodeIntKeyCbor(
    new Map<number, unknown>([
      [COSE_HEADER_ALG, alg],
      [COSE_HEADER_CTY, DELEGATION_CONTENT_TYPE],
      [COSE_HEADER_KID, address],
    ]),
  );
  const delegatedPublicKeyCbor = encodeIntKeyCbor(
    new Map<number, unknown>([
      [COSE_KTY, COSE_KTY_EC2],
      [COSE_CRV, COSE_CRV_P256],
      [COSE_X, new Uint8Array(32).fill(1)],
      [COSE_Y, new Uint8Array(32).fill(2)],
    ]),
  );
  const payloadBytes = buildDelegationPayloadBytes({
    logIdHex32: "0123456789abcdef0123456789abcdef",
    mmrStart: 0n,
    mmrEnd: 10n,
    delegatedPublicKeyCbor,
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_003_600,
    delegationId: new Uint8Array(16).fill(0xab),
  });
  const tbs = buildDelegationToBeSigned(protectedBytes, payloadBytes);
  const sig = secp256k1.sign(keccak_256(tbs.sigStructureBytes), sk, {
    lowS: true,
  });
  const signature = new Uint8Array(65);
  signature.set(sig.toCompactRawBytes(), 0);
  signature[64] = sig.recovery ?? 0;
  return assembleDelegationCertificate(tbs, signature);
}

/** Re-encode `certificate` with a WebAuthn envelope in its unprotected map. */
function withWebauthnEnvelope(certificate: Uint8Array): Uint8Array {
  const { protectedBytes, payloadBytes, signature } =
    decodeCoseSign1Parts(certificate);
  return encodeIntKeyCbor([
    protectedBytes,
    new Map<number, unknown>([
      [COSE_ALG_ES256_WEBAUTHN, [new Uint8Array(37), new Uint8Array(8)]],
    ]),
    payloadBytes,
    signature,
  ]);
}

describe("KS256 alg binding", () => {
  it("accepts a KS256 certificate the root signed", async () => {
    const { sk, address } = newRoot();
    const cert = signedCertificate(COSE_ALG_KS256, sk, address);
    expect(await verifyDelegationCertificateKs256(cert, address)).toBe(true);
  });

  it("refuses a recoverable signature under a non-KS256 alg", async () => {
    const { sk, address } = newRoot();
    const cert = signedCertificate(COSE_ALG_ES256, sk, address);
    expect(await verifyDelegationCertificateKs256(cert, address)).toBe(false);
    expect(() => extractKs256CertificateDigest(cert)).toThrow(/not KS256/);
  });

  it("refuses a WebAuthn envelope on a KS256 certificate", async () => {
    const { sk, address } = newRoot();
    const cert = withWebauthnEnvelope(
      signedCertificate(COSE_ALG_KS256, sk, address),
    );
    expect(await verifyDelegationCertificateKs256(cert, address)).toBe(false);
    expect(() => extractKs256CertificateDigest(cert)).toThrow(/WebAuthn/);
  });

  it("refuses a text alg that only coerces to KS256", async () => {
    const { sk, address } = newRoot();
    const cert = signedCertificate(String(COSE_ALG_KS256), sk, address);
    expect(await verifyDelegationCertificateKs256(cert, address)).toBe(false);
  });

  it("refuses, rather than throws on, a text-keyed unprotected header", async () => {
    const { sk, address } = newRoot();
    const { protectedBytes, payloadBytes, signature } = decodeCoseSign1Parts(
      signedCertificate(COSE_ALG_KS256, sk, address),
    );
    const cert = encodeIntKeyCbor([
      protectedBytes,
      new Map<string, unknown>([["x", 1]]),
      payloadBytes,
      signature,
    ]);
    expect(await verifyDelegationCertificateKs256(cert, address)).toBe(false);
  });

  it("refuses before consulting ERC-1271 hooks", async () => {
    const { sk, address } = newRoot();
    const cert = signedCertificate(COSE_ALG_ES256, sk, address);
    let consulted = false;
    const ok = await verifyDelegationCertificateKs256(cert, address, {
      hasContractCode: async () => {
        consulted = true;
        return true;
      },
      isValidSignature: async () => true,
    });
    expect(ok).toBe(false);
    expect(consulted).toBe(false);
  });
});

describe("extractKs256CertificateDigest", () => {
  it("returns the kid address, keccak256(Sig_structure) and signature", () => {
    const { sk, address } = newRoot();
    const cert = signedCertificate(COSE_ALG_KS256, sk, address);
    const {
      address: kid,
      digest,
      signature,
    } = extractKs256CertificateDigest(cert);
    expect(kid).toEqual(address);
    expect(signature.length).toBe(65);
    const recovered = secp256k1.Signature.fromCompact(signature.slice(0, 64))
      .addRecoveryBit(signature[64]!)
      .recoverPublicKey(digest)
      .toRawBytes(false);
    expect(keccak_256(recovered.slice(1)).slice(-20)).toEqual(address);
  });
});
