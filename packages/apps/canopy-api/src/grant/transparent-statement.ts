/**
 * Decode SCITT transparent statement (Plan 0005, Plan 0014).
 * Custodian profile: COSE payload = 32-byte SHA-256(grant payload); full grant
 * v0 CBOR in unprotected HEADER_FORESTRIE_GRANT_V0. Unprotected 396 = receipt;
 * -65537 = idtimestamp (8-byte bstr).
 */

import { sha256 } from "@noble/hashes/sha256";
import { decode as decodeCbor } from "cbor-x";
import type { GrantResult } from "./grant-result.js";
import type { ParsedReceipt } from "./parsed-receipt.js";
import { decodeGrantPayload } from "./codec.js";
import { parseReceipt } from "./receipt-verify.js";

/** Full SCITT receipt (COSE Sign1 bytes) in transparent statement unprotected (Plan 0005). */
export const HEADER_RECEIPT = 396;
export const HEADER_IDTIMESTAMP = -65537;
/** Full grant v0 CBOR when COSE payload is Custodian digest attestation (Plan 0014). */
export const HEADER_FORESTRIE_GRANT_V0 = -65538;
const IDTIMESTAMP_BYTES = 8;

function digestEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i] ^ b[i];
  return x === 0;
}

function toHeaderMap(
  value: Map<number, unknown> | Record<string, unknown> | unknown,
): Map<number, unknown> {
  if (value instanceof Map) return value as Map<number, unknown>;
  if (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Uint8Array)
  ) {
    const out = new Map<number, unknown>();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const n = Number(k);
      if (Number.isFinite(n)) out.set(n, v);
    }
    return out;
  }
  return new Map();
}

/**
 * Decode raw bytes of a SCITT transparent statement into GrantResult.
 * Sign1 payload is always the 32-byte SHA-256 digest of grant v0 CBOR; full grant
 * bytes are in unprotected {@link HEADER_FORESTRIE_GRANT_V0}. idtimestamp from
 * -65537; receipt from 396 (full receipt COSE Sign1 bytes).
 */
export function decodeTransparentStatement(bytes: Uint8Array): GrantResult {
  const raw = decodeCbor(bytes) as unknown;
  const arr = Array.isArray(raw) ? raw : null;
  if (!arr || arr.length !== 4) {
    throw new Error("Transparent statement must be COSE Sign1 (array of 4)");
  }
  const [, unprotectedRaw, payloadRaw] = arr as [
    unknown,
    Map<number, unknown> | Record<string, unknown>,
    Uint8Array | null,
    unknown,
  ];
  if (!(payloadRaw instanceof Uint8Array) || payloadRaw.length !== 32) {
    throw new Error(
      "Forestrie-Grant must use Custodian COSE profile: Sign1 payload is 32-byte SHA-256 digest of grant v0 CBOR",
    );
  }
  const unprotected = toHeaderMap(unprotectedRaw);

  const embedded = unprotected.get(HEADER_FORESTRIE_GRANT_V0);
  if (!(embedded instanceof Uint8Array) || embedded.length === 0) {
    throw new Error(
      "Forestrie-Grant requires unprotected header -65538 (full grant v0 CBOR) alongside digest payload",
    );
  }
  const expected = sha256(embedded);
  if (!digestEquals(expected, payloadRaw)) {
    throw new Error(
      "Forestrie-Grant: COSE payload digest does not match embedded grant (-65538)",
    );
  }
  const grantPayloadBytes = embedded;

  const idtimestampVal = unprotected.get(HEADER_IDTIMESTAMP);
  const idtimestamp: Uint8Array =
    idtimestampVal instanceof Uint8Array &&
    idtimestampVal.length >= IDTIMESTAMP_BYTES
      ? idtimestampVal.length === IDTIMESTAMP_BYTES
        ? idtimestampVal
        : idtimestampVal.slice(-IDTIMESTAMP_BYTES)
      : new Uint8Array(IDTIMESTAMP_BYTES); // bootstrap: 8 zero bytes

  let receipt: ParsedReceipt | undefined;
  const receiptVal = unprotected.get(HEADER_RECEIPT);
  if (receiptVal instanceof Uint8Array && receiptVal.length > 0) {
    const { explicitPeak, proof } = parseReceipt(receiptVal);
    receipt = { explicitPeak, proof };
  }

  const grant = decodeGrantPayload(grantPayloadBytes);

  return {
    grant,
    idtimestamp,
    receipt,
    bytes,
  };
}
