/**
 * Shared grant-completion logic for resolve-receipt-to-grant and generate-grant-pool.
 * Pure helpers; no I/O. Used by perf scripts and unit tests.
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";

export const HEADER_IDTIMESTAMP = -65537;
export const HEADER_RECEIPT = 396;
export const IDTIMESTAMP_BYTES = 8;

/** 32-char hex entryId (16 bytes) → first 8 bytes (idtimestamp, big-endian). */
export function entryIdToIdtimestamp(entryIdHex: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/i.test(entryIdHex)) {
    throw new Error("entryId must be 32 hex chars");
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(entryIdHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.slice(0, IDTIMESTAMP_BYTES);
}

/** Parse receipt URL path .../entries/{entryId}/receipt → entryId (32 hex). */
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
  const grantBytes = decodeBase64ToBytes(originalGrantBase64);
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
 * Grant payload (COSE index 2) CBOR map key 6 **grantData** → hex for k6 **kid**,
 * matching `statementSignerBindingBytes` (first 32 bytes if grantData is 64-byte ES256 x||y).
 */
export function signerHexFromGrantPayload(payload: Uint8Array): string {
  const map = decodeCbor(payload) as
    | Map<number, Uint8Array>
    | Record<number, Uint8Array>;
  const gd = map.get?.(6) ?? (map as Record<number, Uint8Array>)[6];
  if (!(gd instanceof Uint8Array) || gd.length === 0) {
    throw new Error("Grant payload missing grantData (key 6) for statement signer");
  }
  const bind = gd.length === 64 ? gd.subarray(0, 32) : gd.subarray(0, Math.min(32, gd.length));
  if (bind.length < 1) {
    throw new Error("Grant grantData too short for statement signer binding");
  }
  return Array.from(bind)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0));
}
