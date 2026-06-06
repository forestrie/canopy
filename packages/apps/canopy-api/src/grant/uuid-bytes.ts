/**
 * UUID (logId) as 16-byte representation. Grant/genesis CBOR and on-chain
 * commitments use 32-byte right-padded wire form at those boundaries only.
 */

export const LOG_ID_BYTES = 16;

/** Wire format fixed length for grant/genesis CBOR and commitment preimage. */
export const WIRE_LOG_ID_BYTES = 32;

/** Semantic log id: 16-byte UUID. */
export type LogId = Uint8Array;

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
 * Decode bytes to a UUID string. Accepts 16 bytes (semantic) or 32-byte padded wire.
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

/**
 * Parse a route or storage path segment to 16-byte log id. Accepts canonical UUID
 * or 32-char hex; rejects 64-char padded wire hex.
 */
export function parseLogIdSegment(segment: string): Uint8Array {
  const s = segment.replace(/-/g, "").trim().toLowerCase();
  if (s.length === 64) {
    throw new Error("logId segment must be UUID or 32 hex chars, not 64");
  }
  if (s.length === 32 && /^[0-9a-f]+$/.test(s)) {
    return uuidToBytes(segment.includes("-") ? segment : formatDashedUuid(s));
  }
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      segment.trim(),
    )
  ) {
    return uuidToBytes(segment);
  }
  throw new Error("logId must be a canonical UUID or 32 hex chars");
}

function formatDashedUuid(hex32: string): string {
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20, 32)}`;
}

/** Canonical dashed UUID for R2 / HTTP storage path segments. */
export function logIdToStorageSegment(logId: Uint8Array): string {
  return bytesToUuid(logId);
}

/** Right-pad a 16-byte UUID into 32-byte grant/genesis CBOR wire form. */
export function toPaddedWire32(logId: Uint8Array): Uint8Array {
  const u =
    logId.length === WIRE_LOG_ID_BYTES ? logId.slice(-LOG_ID_BYTES) : logId;
  if (u.length !== LOG_ID_BYTES) {
    throw new Error(`logId must be ${LOG_ID_BYTES} bytes`);
  }
  const out = new Uint8Array(WIRE_LOG_ID_BYTES);
  out.set(u, WIRE_LOG_ID_BYTES - LOG_ID_BYTES);
  return out;
}

/** Normalize grant/genesis CBOR wire bstr to 16-byte UUID. */
export function fromPaddedWire32(wire: Uint8Array): Uint8Array {
  if (wire.length === LOG_ID_BYTES) return wire;
  if (wire.length === WIRE_LOG_ID_BYTES) return wire.slice(-LOG_ID_BYTES);
  if (wire.length > 0 && wire.length <= WIRE_LOG_ID_BYTES) {
    const out = new Uint8Array(WIRE_LOG_ID_BYTES);
    out.set(wire, WIRE_LOG_ID_BYTES - wire.length);
    return out.slice(-LOG_ID_BYTES);
  }
  throw new Error(`invalid logId wire length ${wire.length}`);
}

/**
 * 32-char lowercase hex for Custodian `GET …/curator/log-key?logId=` (no hyphens).
 */
export function logIdBytesToCustodianLowerHex(bytes: Uint8Array): string {
  const u = fromPaddedWire32(bytes);
  return Array.from(u)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
