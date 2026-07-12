/**
 * Shape assertions for grant transparent statements (Plan 0014 /
 * `transparent-statement.ts`): COSE Sign1 with 32-byte digest payload and the
 * full grant v0 CBOR embedded in unprotected header -65538.
 */

import { decode } from "cbor-x";
import { base64ToBytes } from "./grant-base64.js";
import { HEADER_FORESTRIE_GRANT_V0 } from "./transparent-statement.js";

function toHeaderMap(raw: unknown): Map<number, unknown> {
  if (raw instanceof Map) return raw as Map<number, unknown>;
  if (typeof raw === "object" && raw !== null && !(raw instanceof Uint8Array)) {
    const out = new Map<number, unknown>();
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const n = Number(k);
      if (Number.isFinite(n)) out.set(n, v);
    }
    return out;
  }
  return new Map();
}

/**
 * Assert base64 body matches Custodian Forestrie-Grant wire: COSE Sign1, 32-byte
 * digest payload, unprotected -65538 carries grant v0 CBOR.
 */
export function assertCustodianProfileTransparentStatement(
  base64: string,
): void {
  const bytes = base64ToBytes(base64);

  const sign1 = decode(bytes) as unknown;
  if (!Array.isArray(sign1) || sign1.length !== 4) {
    throw new Error("Expected untagged COSE Sign1 (CBOR array of 4 elements)");
  }
  const payload = sign1[2];
  if (!(payload instanceof Uint8Array) || payload.length !== 32) {
    throw new Error(
      "Expected COSE payload to be 32-byte SHA-256 digest (Custodian profile)",
    );
  }
  const sig = sign1[3];
  if (!(sig instanceof Uint8Array) || sig.length !== 64) {
    throw new Error(
      "Expected COSE ES256 signature bstr to be 64-byte IEEE P1363 (not KMS DER)",
    );
  }
  const unprotected = toHeaderMap(sign1[1]);
  const embedded = unprotected.get(HEADER_FORESTRIE_GRANT_V0);
  if (!(embedded instanceof Uint8Array) || embedded.length === 0) {
    throw new Error(
      `Expected unprotected header ${HEADER_FORESTRIE_GRANT_V0} (grant v0 CBOR bytes)`,
    );
  }
}

/** COSE protected header alg label. */
const COSE_HEADER_ALG = 1;
const COSE_ALG_ES256 = -7;
const COSE_ALG_KS256 = -65799;

function algFromProtectedHeader(
  protectedBytes: Uint8Array,
): number | undefined {
  try {
    const decoded = decode(protectedBytes) as unknown;
    const m = toHeaderMap(decoded);
    const alg = m.get(COSE_HEADER_ALG);
    return typeof alg === "number" ? alg : undefined;
  } catch {
    return undefined;
  }
}

/** Assert root grant COSE Sign1 has 32-byte digest payload and grant v0 embedded. */
export function assertRootGrantTransparentStatement(base64: string): void {
  const bytes = base64ToBytes(base64);

  const sign1 = decode(bytes) as unknown;
  if (!Array.isArray(sign1) || sign1.length !== 4) {
    throw new Error("Expected untagged COSE Sign1 (CBOR array of 4 elements)");
  }
  const payload = sign1[2];
  if (!(payload instanceof Uint8Array) || payload.length !== 32) {
    throw new Error("Expected COSE payload to be 32-byte SHA-256 digest");
  }
  const sig = sign1[3];
  const protectedBytes =
    sign1[0] instanceof Uint8Array ? sign1[0] : new Uint8Array(0);
  const alg = algFromProtectedHeader(protectedBytes);
  const expectedSigLen = alg === COSE_ALG_KS256 ? 65 : 64;
  if (!(sig instanceof Uint8Array) || sig.length !== expectedSigLen) {
    throw new Error(
      `Expected COSE ${alg === COSE_ALG_KS256 ? "KS256" : "ES256"} signature ` +
        `to be ${expectedSigLen} bytes`,
    );
  }
  if (alg !== COSE_ALG_ES256 && alg !== COSE_ALG_KS256) {
    throw new Error(`Unexpected grant protected alg ${String(alg)}`);
  }
  const unprotected = toHeaderMap(sign1[1]);
  const embedded = unprotected.get(HEADER_FORESTRIE_GRANT_V0);
  if (!(embedded instanceof Uint8Array) || embedded.length === 0) {
    throw new Error(
      `Expected unprotected header ${HEADER_FORESTRIE_GRANT_V0} (grant v0 CBOR bytes)`,
    );
  }
}
