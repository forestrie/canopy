/**
 * Grant request CBOR encoder (Forestrie-Grant **v0**).
 * Emits CBOR map keys **1–6** only (grant content; no idtimestamp). Idtimestamp is supplied
 * separately by the server. Use for POST /register/grants body.
 */

const WIRE_LOG_ID_OWNER_LOG_ID_BYTES = 32;
const WIRE_GRANT_FLAGS_BYTES = 8;
const CBOR_BSTR_LEN_8 = 0x48;
const CBOR_BSTR_LEN32_LEAD = 0x58;

function leftPad(b: Uint8Array, length: number): Uint8Array {
  if (b.length >= length) {
    return b.length === length ? b : b.slice(-length);
  }
  const out = new Uint8Array(length);
  out.set(b, length - b.length);
  return out;
}

function appendCborUint(b: number[], v: number): void {
  if (v < 24) b.push(v);
  else if (v <= 0xff) b.push(0x18, v);
  else if (v <= 0xffff) {
    b.push(0x19, (v >> 8) & 0xff, v & 0xff);
  } else if (v <= 0xffffffff) {
    b.push(0x1a, (v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  } else {
    const lo = v >>> 0;
    const hi = (v / 0x100000000) >>> 0;
    b.push(
      0x1b,
      (hi >> 24) & 0xff,
      (hi >> 16) & 0xff,
      (hi >> 8) & 0xff,
      hi & 0xff,
      (lo >> 24) & 0xff,
      (lo >> 16) & 0xff,
      (lo >> 8) & 0xff,
      lo & 0xff,
    );
  }
}

function appendCborBstr(b: number[], s: Uint8Array): void {
  const n = s.length;
  if (n < 24) b.push(0x40 | n);
  else if (n <= 0xff) b.push(0x58, n);
  else if (n <= 0xffff) {
    b.push(0x59, (n >> 8) & 0xff, n & 0xff);
  } else {
    b.push(0x5a, (n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  for (let i = 0; i < n; i++) b.push(s[i]!);
}

/** Wire format key labels (grant content keys 1–6 only, v0). */
export const GRANT_REQUEST_KEYS = {
  logId: 1,
  ownerLogId: 2,
  /** Solidity `PublishGrant.grant` (flags); CBOR key 3. */
  grant: 3,
  maxHeight: 4,
  minGrowth: 5,
  grantData: 6,
} as const;

export interface GrantRequestInput {
  logId: Uint8Array;
  ownerLogId: Uint8Array;
  /** 8-byte grant flags bitmap (`PublishGrant.grant` on-chain). */
  grant: Uint8Array;
  maxHeight?: number;
  minGrowth?: number;
  grantData: Uint8Array;
}

/**
 * Encode grant content as CBOR (keys 1–6 only). Left-pads logId/ownerLogId to 32,
 * grant flags to 8.
 */
export function encodeGrantRequest(input: GrantRequestInput): Uint8Array {
  const logId32 = leftPad(input.logId, WIRE_LOG_ID_OWNER_LOG_ID_BYTES);
  const ownerLogId32 = leftPad(
    input.ownerLogId,
    WIRE_LOG_ID_OWNER_LOG_ID_BYTES,
  );
  const flags8 = leftPad(input.grant, WIRE_GRANT_FLAGS_BYTES);
  const maxHeight = input.maxHeight ?? 0;
  const minGrowth = input.minGrowth ?? 0;
  const grantData = input.grantData ?? new Uint8Array(0);

  const b: number[] = [];
  b.push(0xa6); // map(6)
  b.push(0x01, CBOR_BSTR_LEN32_LEAD, WIRE_LOG_ID_OWNER_LOG_ID_BYTES);
  for (let i = 0; i < WIRE_LOG_ID_OWNER_LOG_ID_BYTES; i++) b.push(logId32[i]!);
  b.push(0x02, CBOR_BSTR_LEN32_LEAD, WIRE_LOG_ID_OWNER_LOG_ID_BYTES);
  for (let i = 0; i < WIRE_LOG_ID_OWNER_LOG_ID_BYTES; i++)
    b.push(ownerLogId32[i]!);
  b.push(0x03, CBOR_BSTR_LEN_8);
  for (let i = 0; i < WIRE_GRANT_FLAGS_BYTES; i++) b.push(flags8[i]!);
  b.push(0x04);
  appendCborUint(b, maxHeight);
  b.push(0x05);
  appendCborUint(b, minGrowth);
  b.push(0x06);
  appendCborBstr(b, grantData);
  return new Uint8Array(b);
}
