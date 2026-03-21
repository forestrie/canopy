/**
 * Inline grant-completion helpers for e2e (build completed transparent statement).
 * Mirrors perf/lib/grant-completion.ts so e2e does not depend on @canopy/perf.
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";

const HEADER_IDTIMESTAMP = -65537;
const HEADER_RECEIPT = 396;
const IDTIMESTAMP_BYTES = 8;

function entryIdToIdtimestamp(entryIdHex: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/i.test(entryIdHex)) {
    throw new Error("entryId must be 32 hex chars");
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(entryIdHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.slice(0, IDTIMESTAMP_BYTES);
}

export function extractEntryIdFromReceiptUrl(url: string): string {
  const path = url.includes("?") ? url.slice(0, url.indexOf("?")) : url;
  const segments = path.split("/");
  const receiptIndex = segments.indexOf("receipt");
  if (receiptIndex < 1) {
    throw new Error("receipt URL must contain .../entries/{entryId}/receipt");
  }
  const entryId = segments[receiptIndex - 1];
  if (!entryId || entryId.length !== 32) {
    throw new Error("entryId segment must be 32 hex chars");
  }
  return entryId;
}

/** Build completed transparent statement (original grant + idtimestamp + receipt in unprotected). */
export function buildCompletedGrant(
  originalGrantBase64: string,
  receiptUrl: string,
  receiptBytes: Uint8Array,
): string {
  const entryIdHex = extractEntryIdFromReceiptUrl(receiptUrl);
  const idtimestamp = entryIdToIdtimestamp(entryIdHex);
  const normalized = originalGrantBase64.replace(/-/g, "+").replace(/_/g, "/");
  const grantBytes = new Uint8Array(
    atob(normalized).split("").map((c) => c.charCodeAt(0)),
  );
  const cose = decodeCbor(grantBytes) as unknown[];
  if (!Array.isArray(cose) || cose.length !== 4) {
    throw new Error("Original grant must be COSE Sign1 (array of 4)");
  }
  const [protectedHeader, , payload, signature] = cose as [
    Uint8Array,
    unknown,
    Uint8Array,
    Uint8Array,
  ];
  const unprotected = new Map<number, unknown>([
    [HEADER_IDTIMESTAMP, idtimestamp],
    [HEADER_RECEIPT, receiptBytes],
  ]);
  const completed = [protectedHeader, unprotected, payload, signature];
  const completedBytes = new Uint8Array(encodeCbor(completed));
  return btoa(String.fromCharCode(...completedBytes));
}

/**
 * COSE `kid` bytes that match {@link statementSignerBindingBytes} for this Forestrie-Grant
 * (transparent statement base64). Same rule as API: 64-byte grantData → first 32 bytes; else full grantData.
 */
export function statementKidBytesFromForestrieGrantBase64(
  forestrieGrantBase64: string,
): Uint8Array {
  const normalized = forestrieGrantBase64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const grantBytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    grantBytes[i] = raw.charCodeAt(i);
  }
  const cose = decodeCbor(grantBytes) as unknown[];
  if (!Array.isArray(cose) || cose.length < 3) {
    throw new Error("Forestrie-Grant must be COSE Sign1 (array of at least 3)");
  }
  const payload = cose[2];
  if (!(payload instanceof Uint8Array)) {
    throw new Error("Forestrie-Grant COSE payload must be bstr");
  }
  const map = decodeCbor(payload) as Map<number, Uint8Array> | Record<number, unknown>;
  const gd =
    map instanceof Map ? map.get(6) : (map as Record<number, unknown>)[6];
  if (!(gd instanceof Uint8Array) || gd.length === 0) {
    throw new Error("Grant payload missing grantData (CBOR key 6)");
  }
  if (gd.length === 64) return gd.subarray(0, 32);
  return gd;
}
