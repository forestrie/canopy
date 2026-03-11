/**
 * UUID (logId) as 16-byte representation. Wire format (go-univocity) uses 32 bytes
 * (left-padded); API URLs use 16-byte UUID. LOG_ID_BYTES = semantic UUID size.
 */

export const LOG_ID_BYTES = 16;

/** Wire format fixed length for logId/ownerLogId (go-univocity). */
export const WIRE_LOG_ID_BYTES = 32;

/**
 * Encode a UUID string to 16 bytes (big-endian hex).
 */
export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) {
    throw new Error(`Invalid UUID length: ${hex.length}`);
  }
  const bytes = new Uint8Array(LOG_ID_BYTES);
  for (let i = 0; i < LOG_ID_BYTES; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Decode bytes to a UUID string. Accepts 16 bytes (semantic UUID) or 32 bytes
 * (wire format); for 32 bytes the last 16 are used (right-aligned).
 */
export function bytesToUuid(bytes: Uint8Array): string {
  const u =
    bytes.length === WIRE_LOG_ID_BYTES ? bytes.slice(-LOG_ID_BYTES) : bytes;
  if (u.length !== LOG_ID_BYTES) {
    throw new Error(
      `Expected ${LOG_ID_BYTES} or ${WIRE_LOG_ID_BYTES} bytes for UUID, got ${bytes.length}`,
    );
  }
  const hex = Array.from(u)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
