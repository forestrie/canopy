/**
 * Decode SCITT transparent statement (Plan 0005).
 * COSE Sign1: payload = grant v0 (keys 1–6, no idtimestamp); unprotected 396 = receipt (full COSE Sign1 bytes); -65537 = idtimestamp (8-byte bstr).
 */

import { decode as decodeCbor } from "cbor-x";
import type { GrantResult } from "./grant-result.js";
import type { ParsedReceipt } from "./parsed-receipt.js";
import { decodeGrantPayload } from "./codec.js";
import { parseReceipt } from "./receipt-verify.js";

const HEADER_RECEIPT = 396;
const HEADER_IDTIMESTAMP = -65537;
const IDTIMESTAMP_BYTES = 8;

function toHeaderMap(
  value: Map<number, unknown> | Record<string, unknown> | unknown,
): Map<number, unknown> {
  if (value instanceof Map) return value as Map<number, unknown>;
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array)) {
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
 * Payload = grant content (CBOR map keys 1–6); idtimestamp from header -65537 only; receipt from header 396 (full receipt COSE Sign1 bytes).
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
  if (!(payloadRaw instanceof Uint8Array) || payloadRaw.length === 0) {
    throw new Error("Transparent statement payload must be non-empty bstr");
  }
  const unprotected = toHeaderMap(unprotectedRaw);

  const idtimestampVal = unprotected.get(HEADER_IDTIMESTAMP);
  const idtimestamp: Uint8Array =
    idtimestampVal instanceof Uint8Array && idtimestampVal.length >= IDTIMESTAMP_BYTES
      ? idtimestampVal.length === IDTIMESTAMP_BYTES
        ? idtimestampVal
        : idtimestampVal.slice(-IDTIMESTAMP_BYTES)
      : new Uint8Array(IDTIMESTAMP_BYTES); // bootstrap: 8 zero bytes

  let receipt: ParsedReceipt | undefined;
  const receiptVal = unprotected.get(HEADER_RECEIPT);
  if (receiptVal instanceof Uint8Array && receiptVal.length > 0) {
    const { root, proof } = parseReceipt(receiptVal);
    receipt = { root, proof };
  }

  const grant = decodeGrantPayload(payloadRaw);

  return {
    grant,
    idtimestamp,
    receipt,
    bytes,
  };
}
