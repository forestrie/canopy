/**
 * Sign a Forestrie-Grant v0 payload with an ES256 (P-256) private key PEM,
 * producing the Custodian transparent-statement profile that arbor univocity
 * verifies (`verifyCoseSign1ES256`):
 *
 * - COSE Sign1, untagged array of 4.
 * - Protected header `{1: -7}` (ES256), wire `0xa10126`.
 * - Payload = 32-byte SHA-256 of the grant v0 CBOR.
 * - Signature = ECDSA P-256 over `SHA-256(CBOR(["Signature1", protected, h'',
 *   payload]))`, raw IEEE P1363 `r‖s` (64 bytes).
 * - Unprotected header carries the full grant v0 CBOR (-65538) and an 8-byte
 *   zero idtimestamp (-65537).
 *
 * **Canonical CBOR by hand** — see `grant-payload-canonical.ts`.
 *
 * **Node-only module.** Uses `node:crypto` (which imports SEC1 or PKCS#8 EC
 * PEMs and emits `ieee-p1363` raw signatures) rather than WebCrypto
 * (SubtleCrypto only imports PKCS#8 EC keys). Everything else in this package
 * is browser-safe.
 */

import { createHash, createPrivateKey, sign as nodeSign } from "node:crypto";
import { appendCborBstr, appendCborText } from "./grant-payload-canonical.js";

/** COSE protected header `{1: -7}` (ES256), canonical wire bytes. */
const ES256_PROTECTED_HEADER = new Uint8Array([0xa1, 0x01, 0x26]);
const IDTIMESTAMP_BYTES = 8;
const ES256_RAW_SIG_BYTES = 64;
// CBOR negative-int keys (major type 1): -65538 and -65537.
const CBOR_KEY_FORESTRIE_GRANT_V0 = [0x3a, 0x00, 0x01, 0x00, 0x01];
const CBOR_KEY_IDTIMESTAMP = [0x3a, 0x00, 0x01, 0x00, 0x00];

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

/**
 * Sign a grant v0 payload with an ES256 EC private key PEM, returning the
 * Custodian-profile COSE Sign1 wire bytes (canonical CBOR).
 *
 * @param grantPayloadBytes - canonical grant v0 CBOR (keys 1-6).
 * @param es256PrivateKeyPem - SEC1 or PKCS#8 P-256 EC private key PEM.
 */
export function signGrantPayloadWithEs256Pem(
  grantPayloadBytes: Uint8Array,
  es256PrivateKeyPem: string,
): Uint8Array {
  const payload = sha256(grantPayloadBytes);

  const sig: number[] = [0x84]; // array(4)
  appendCborText(sig, "Signature1");
  appendCborBstr(sig, ES256_PROTECTED_HEADER);
  appendCborBstr(sig, new Uint8Array(0));
  appendCborBstr(sig, payload);
  const sigStructure = new Uint8Array(sig);

  const key = createPrivateKey({ key: es256PrivateKeyPem, format: "pem" });
  const signature = new Uint8Array(
    nodeSign("sha256", Buffer.from(sigStructure), {
      key,
      dsaEncoding: "ieee-p1363",
    }),
  );
  if (signature.length !== ES256_RAW_SIG_BYTES) {
    throw new Error(
      `ES256 signature must be ${ES256_RAW_SIG_BYTES}-byte raw r‖s; got ${signature.length}`,
    );
  }

  const out: number[] = [0x84]; // Sign1 array(4)
  appendCborBstr(out, ES256_PROTECTED_HEADER);
  out.push(0xa2); // unprotected map(2)
  out.push(...CBOR_KEY_FORESTRIE_GRANT_V0);
  appendCborBstr(out, grantPayloadBytes);
  out.push(...CBOR_KEY_IDTIMESTAMP);
  appendCborBstr(out, new Uint8Array(IDTIMESTAMP_BYTES));
  appendCborBstr(out, payload);
  appendCborBstr(out, signature);
  return new Uint8Array(out);
}

/** ES256 P-256 public key (uncompressed `x‖y`, 64 bytes) from an EC private key PEM. */
export function es256GrantData64FromPrivateKeyPem(
  es256PrivateKeyPem: string,
): Uint8Array {
  const key = createPrivateKey({ key: es256PrivateKeyPem, format: "pem" });
  const jwk = key.export({ format: "jwk" });
  if (
    jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" ||
    typeof jwk.y !== "string"
  ) {
    throw new Error("ES256 bootstrap PEM must be a P-256 EC private key");
  }
  const x = base64UrlToBytes(jwk.x);
  const y = base64UrlToBytes(jwk.y);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("ES256 public key coordinates must be 32 bytes each");
  }
  const out = new Uint8Array(64);
  out.set(x, 0);
  out.set(y, 32);
  return out;
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
