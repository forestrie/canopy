/**
 * UUID (logId) as 16-byte representation. On-chain may use 32 bytes; API uses 16 for UUID.
 */

export const LOG_ID_BYTES = 16;

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
 * Decode 16 bytes to a UUID string.
 */
export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length !== LOG_ID_BYTES) {
    throw new Error(`Expected ${LOG_ID_BYTES} bytes for UUID, got ${bytes.length}`);
  }
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
