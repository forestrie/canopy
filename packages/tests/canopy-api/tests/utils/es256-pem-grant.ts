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
 * **Canonical CBOR by hand.** arbor (fxamacker) rebuilds the `Sig_structure`
 * from the bare protected/payload byte strings, so the signed bytes must be
 * canonical. `cbor-x` would tag `Map` (tag 259) and `Uint8Array` (tag 64),
 * which diverges from arbor's canonical encoding and breaks verification — so
 * the grant payload, `Sig_structure`, and Sign1 are emitted byte-by-byte here.
 *
 * Runs in the Playwright Node runner, so it uses `node:crypto` (which imports
 * SEC1 or PKCS#8 EC PEMs and emits `ieee-p1363` raw signatures) rather than
 * WebCrypto (SubtleCrypto only imports PKCS#8 EC keys).
 */

import { createHash, createPrivateKey, sign as nodeSign } from "node:crypto";
import type { Grant } from "@e2e-canopy-api-src/grant/types.js";
import { toPaddedWire32 } from "@e2e-canopy-api-src/grant/uuid-bytes.js";
import { grantDataToBytes } from "@e2e-canopy-api-src/grant/grant-data.js";

/** COSE protected header `{1: -7}` (ES256), canonical wire bytes. */
const ES256_PROTECTED_HEADER = new Uint8Array([0xa1, 0x01, 0x26]);
const IDTIMESTAMP_BYTES = 8;
const ES256_RAW_SIG_BYTES = 64;
const WIRE_GRANT_FLAGS_BYTES = 8;
// CBOR negative-int keys (major type 1): -65538 and -65537.
const CBOR_KEY_FORESTRIE_GRANT_V0 = [0x3a, 0x00, 0x01, 0x00, 0x01];
const CBOR_KEY_IDTIMESTAMP = [0x3a, 0x00, 0x01, 0x00, 0x00];

function appendCborUint(out: number[], v: number): void {
  if (v < 24) out.push(v);
  else if (v <= 0xff) out.push(0x18, v);
  else if (v <= 0xffff) out.push(0x19, (v >> 8) & 0xff, v & 0xff);
  else
    out.push(
      0x1a,
      (v >>> 24) & 0xff,
      (v >> 16) & 0xff,
      (v >> 8) & 0xff,
      v & 0xff,
    );
}

/** Append a CBOR byte string (major type 2) with canonical length prefix. */
function appendCborBstr(out: number[], bytes: Uint8Array): void {
  const n = bytes.length;
  if (n < 24) out.push(0x40 | n);
  else if (n <= 0xff) out.push(0x58, n);
  else if (n <= 0xffff) out.push(0x59, (n >> 8) & 0xff, n & 0xff);
  else
    out.push(
      0x5a,
      (n >>> 24) & 0xff,
      (n >> 16) & 0xff,
      (n >> 8) & 0xff,
      n & 0xff,
    );
  for (let i = 0; i < n; i++) out.push(bytes[i]!);
}

/** Append a CBOR text string (major type 3). */
function appendCborText(out: number[], s: string): void {
  const bytes = new TextEncoder().encode(s);
  const n = bytes.length;
  if (n < 24) out.push(0x60 | n);
  else if (n <= 0xff) out.push(0x78, n);
  else out.push(0x79, (n >> 8) & 0xff, n & 0xff);
  for (let i = 0; i < n; i++) out.push(bytes[i]!);
}

function leftPad(b: Uint8Array, length: number): Uint8Array {
  if (b.length === length) return b;
  if (b.length > length) return b.slice(-length);
  const out = new Uint8Array(length);
  out.set(b, length - b.length);
  return out;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

/**
 * Canonical grant v0 payload CBOR (map keys 1-6, no idtimestamp), matching
 * `encodeGrantForResponse` minus key 0. Tag-free so arbor decodes `grantData`
 * as a bare 64-byte byte string.
 */
export function encodeGrantPayloadV0Canonical(grant: Grant): Uint8Array {
  const logId32 = toPaddedWire32(grant.logId as Uint8Array);
  const ownerLogId32 = toPaddedWire32(grant.ownerLogId as Uint8Array);
  const flags8 = leftPad(grant.grant as Uint8Array, WIRE_GRANT_FLAGS_BYTES);
  const grantData = grantDataToBytes(grant.grantData ?? new Uint8Array(0));

  const out: number[] = [0xa6]; // map(6) — keys 1-6
  out.push(0x01);
  appendCborBstr(out, logId32);
  out.push(0x02);
  appendCborBstr(out, ownerLogId32);
  out.push(0x03);
  appendCborBstr(out, flags8);
  out.push(0x04);
  appendCborUint(out, grant.maxHeight ?? 0);
  out.push(0x05);
  appendCborUint(out, grant.minGrowth ?? 0);
  out.push(0x06);
  appendCborBstr(out, grantData);
  return new Uint8Array(out);
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
    throw new Error("BOOTSTRAP_PEM_ES256 must be a P-256 EC private key");
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
