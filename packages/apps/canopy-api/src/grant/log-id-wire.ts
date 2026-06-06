/**
 * Log id parsing for routes and storage edges. Internal representation is
 * 16-byte UUID; grant/genesis CBOR uses {@link toPaddedWire32} at encode time.
 */

import {
  bytesToUuid,
  fromPaddedWire32,
  logIdToStorageSegment,
  parseLogIdSegment,
  toPaddedWire32,
  LOG_ID_BYTES,
  WIRE_LOG_ID_BYTES,
} from "./uuid-bytes.js";

export {
  LOG_ID_BYTES,
  WIRE_LOG_ID_BYTES,
  fromPaddedWire32,
  logIdToStorageSegment,
  parseLogIdSegment,
  toPaddedWire32,
};

/** @deprecated Use {@link parseLogIdSegment} for 16-byte UUID. */
export const WIRE_LOG_ID_PARSE_BYTES = WIRE_LOG_ID_BYTES;

/**
 * Parse log id segment to 16-byte UUID (alias for {@link parseLogIdSegment}).
 */
export function logIdToWireBytes(logId: string): Uint8Array {
  return parseLogIdSegment(logId);
}

/**
 * @deprecated Use {@link logIdToStorageSegment}. Kept for tests migrating off hex64.
 */
export function wireLogIdToHex64(wire: Uint8Array): string {
  return logIdToStorageSegment(fromPaddedWire32(wire));
}

/** Canonical UUID form for URL paths (same as MMRS key log id segment). */
export function logIdSegmentToCanonicalUuid(segment: string): string {
  return bytesToUuid(parseLogIdSegment(segment));
}
