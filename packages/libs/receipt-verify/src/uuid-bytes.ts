export const WIRE_LOG_ID_BYTES = 32;

export function toPaddedWire32(bytes: Uint8Array): Uint8Array {
  if (bytes.length === WIRE_LOG_ID_BYTES) return bytes;
  const out = new Uint8Array(WIRE_LOG_ID_BYTES);
  if (bytes.length >= WIRE_LOG_ID_BYTES) {
    out.set(bytes.slice(-WIRE_LOG_ID_BYTES));
  } else {
    out.set(bytes, WIRE_LOG_ID_BYTES - bytes.length);
  }
  return out;
}

export function fromPaddedWire32(wire: Uint8Array): Uint8Array {
  if (wire.length === 16) return wire;
  if (wire.length !== WIRE_LOG_ID_BYTES) {
    throw new Error(`Expected ${WIRE_LOG_ID_BYTES}-byte wire log id`);
  }
  return wire.slice(-16);
}
