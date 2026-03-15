/**
 * In-process signers for local/testing only (DELEGATION_SIGNER_USE_TEST_KEY).
 * ES256 (P-256) by default; KS256 (secp256k1) also supported. No GCP KMS calls.
 * See docs/adr-0002-delegation-signer-local-test-key.md.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "../cose/kid";

/** Well-known test private key (32 bytes). Do not use in production. */
const WELL_KNOWN_TEST_PRIVATE_KEY_HEX =
  "0000000000000000000000000000000000000000000000000000000000000001";
/** Well-known P-256 test private key (32 bytes). Do not use in production. */
const WELL_KNOWN_TEST_P256_PRIVATE_KEY_HEX =
  "0000000000000000000000000000000000000000000000000000000000000002";

function hexToBytes(hex: string): Uint8Array {
  const s = hex.replace(/^0x/i, "").trim().toLowerCase();
  if (s.length !== 64 || !/^[0-9a-f]+$/.test(s)) {
    throw new Error("Private key must be 64 hex chars (32 bytes)");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Build SPKI DER from 65-byte uncompressed public key (04||x||y). */
function publicKeyToSpkiDer(
  uncompressed65: Uint8Array,
  curveOid: Uint8Array,
): Uint8Array {
  if (uncompressed65.length !== 65 || uncompressed65[0] !== 0x04) {
    throw new Error("Expected 65-byte uncompressed public key (04||x||y)");
  }
  const oidEcPublicKey = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
  const algIdSeq = new Uint8Array([
    0x30,
    5 + oidEcPublicKey.length + 2 + curveOid.length,
    0x06,
    oidEcPublicKey.length,
    ...oidEcPublicKey,
    0x06,
    curveOid.length,
    ...curveOid,
  ]);
  const bitStringLen = 2 + 66;
  const bitString = new Uint8Array(bitStringLen);
  bitString[0] = 0x03;
  bitString[1] = 66;
  bitString[2] = 0x00;
  bitString.set(uncompressed65, 3);
  const seqLen = algIdSeq.length + bitStringLen;
  const spki = new Uint8Array(2 + seqLen);
  spki[0] = 0x30;
  spki[1] = seqLen;
  spki.set(algIdSeq, 2);
  spki.set(bitString, 2 + algIdSeq.length);
  return spki;
}

const OID_SECP256K1 = new Uint8Array([0x2b, 0x81, 0x04, 0x00, 0x0a]);
const OID_P256 = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]); // 1.2.840.10045.3.1.7

let cachedPrivateKey: Uint8Array | null = null;
let cachedPublicKeyDer: Uint8Array | null = null;
let cachedKid: Uint8Array | null = null;
let cachedP256PrivateKey: Uint8Array | null = null;
let cachedP256PublicKeyDer: Uint8Array | null = null;

function getPrivateKey(privateHex: string | undefined): Uint8Array {
  if (!cachedPrivateKey) {
    const hex = (privateHex ?? WELL_KNOWN_TEST_PRIVATE_KEY_HEX).trim();
    cachedPrivateKey = hexToBytes(hex);
  }
  return cachedPrivateKey;
}

function getP256PrivateKey(): Uint8Array {
  if (!cachedP256PrivateKey) {
    cachedP256PrivateKey = hexToBytes(WELL_KNOWN_TEST_P256_PRIVATE_KEY_HEX);
  }
  return cachedP256PrivateKey;
}

/**
 * Sign a 32-byte SHA-256 digest with the secp256k1 test key. Returns raw r||s (64 bytes).
 */
export function signDigestSha256(
  digest: Uint8Array,
  privateHex?: string,
): Uint8Array {
  if (digest.length !== 32) {
    throw new Error("Digest must be 32 bytes (SHA-256)");
  }
  const priv = getPrivateKey(privateHex);
  const sig = secp256k1.sign(digest, priv, { prehash: true });
  return sig.toCompactRawBytes();
}

/**
 * Sign a 32-byte SHA-256 digest with the P-256 test key (ES256). Returns raw r||s (64 bytes).
 */
export function signDigestSha256Es256(digest: Uint8Array): Uint8Array {
  if (digest.length !== 32) {
    throw new Error("Digest must be 32 bytes (SHA-256)");
  }
  const priv = getP256PrivateKey();
  const sig = p256.sign(digest, priv, { prehash: true });
  return sig.toCompactRawBytes();
}

/**
 * Return the secp256k1 test key's public key as SPKI DER (for PEM).
 */
export function getTestKeyPublicKeyDer(privateHex?: string): Uint8Array {
  if (!cachedPublicKeyDer) {
    const priv = getPrivateKey(privateHex);
    const pub = secp256k1.getPublicKey(priv, false);
    cachedPublicKeyDer = publicKeyToSpkiDer(pub, OID_SECP256K1);
  }
  return cachedPublicKeyDer;
}

/**
 * Return the P-256 (ES256) test key's public key as SPKI DER (for PEM).
 */
export function getTestKeyPublicKeyDerEs256(): Uint8Array {
  if (!cachedP256PublicKeyDer) {
    const priv = getP256PrivateKey();
    const pub = p256.getPublicKey(priv, false);
    cachedP256PublicKeyDer = publicKeyToSpkiDer(pub, OID_P256);
  }
  return cachedP256PublicKeyDer;
}

/**
 * Return 16-byte kid derived from test key public key (SHA-256(SPKI)[0..16]).
 */
export async function getTestKeyKid(privateHex?: string): Promise<Uint8Array> {
  if (!cachedKid) {
    const der = getTestKeyPublicKeyDer(privateHex);
    const digest = await sha256(der);
    cachedKid = digest.slice(0, 16);
  }
  return cachedKid;
}
