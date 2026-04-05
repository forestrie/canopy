/**
 * 32-byte Forestrie wire `logId` / `ownerLogId` (go-univocity, grant CBOR key 1).
 * Shared by bootstrap mint, genesis, and any route that parses a log id segment.
 */

import { bytesToUuid } from "./uuid-bytes.js";

export const WIRE_LOG_ID_PARSE_BYTES = 32;

/** 64 hex chars → 32 bytes. */
function hexToBytes32(hex: string): Uint8Array {
  const s = hex.replace(/^0x/i, "").trim().toLowerCase();
  if (s.length !== 64 || !/^[0-9a-f]+$/.test(s)) {
    throw new Error("logId must be 64 hex chars (32 bytes)");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Parse log id string to 32-byte wire format. Accepts:
 * - 64 hex chars (32 bytes)
 * - UUID (with or without dashes, 32 hex = 16 bytes), right-aligned in 32-byte buffer
 */
export function logIdToWireBytes(logId: string): Uint8Array {
  const s = logId.replace(/-/g, "").trim().toLowerCase();
  if (s.length === 64 && /^[0-9a-f]+$/.test(s)) {
    return hexToBytes32(s);
  }
  if (s.length === 32 && /^[0-9a-f]+$/.test(s)) {
    const uuidBytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      uuidBytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    }
    const out = new Uint8Array(WIRE_LOG_ID_PARSE_BYTES);
    out.set(uuidBytes, WIRE_LOG_ID_PARSE_BYTES - 16);
    return out;
  }
  throw new Error("logId must be 64 hex chars or a UUID (32 hex)");
}

/** Lowercase 64-hex R2 path segment for a 32-byte wire log id (no `0x`). */
export function wireLogIdToHex64(wire: Uint8Array): string {
  if (wire.length !== WIRE_LOG_ID_PARSE_BYTES) {
    throw new Error(`wire logId must be ${WIRE_LOG_ID_PARSE_BYTES} bytes`);
  }
  return Array.from(wire)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Canonical UUID form for URL paths (same as MMRS key log id segment). */
export function logIdSegmentToCanonicalUuid(segment: string): string {
  return bytesToUuid(logIdToWireBytes(segment));
}
