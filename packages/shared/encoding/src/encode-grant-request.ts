/**
 * Grant request CBOR encoder (Forestrie-Grant **v0**).
 * Emits CBOR map keys **1–6** only (grant content; no idtimestamp). Idtimestamp
 * is supplied separately by canopy-api sequencing. Wire layout:
 * [grants.md §3.1](https://github.com/forestrie/canopy/blob/main/docs/grants.md#31-inner-grant-payload-cbor).
 */

const WIRE_LOG_ID_OWNER_LOG_ID_BYTES = 32;
const WIRE_GRANT_FLAGS_BYTES = 8;
const CBOR_BSTR_LEN_8 = 0x48;
const CBOR_BSTR_LEN32_LEAD = 0x58;

/** Right-pad or truncate to fixed width (univocity/go-univocity wire convention). */
function leftPad(b: Uint8Array, length: number): Uint8Array {
  if (b.length >= length) {
    return b.length === length ? b : b.slice(-length);
  }
  const out = new Uint8Array(length);
  out.set(b, length - b.length);
  return out;
}

/** Append a CBOR unsigned integer in canonical form. */
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

/** Append a CBOR bstr item (header + payload bytes). */
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

/** Grant content fields for POST `/register/grants` CBOR body (keys 1–6). */
export interface GrantRequestInput {
  /** Target log id (padded to 32 bytes on wire). */
  logId: Uint8Array;
  /** Owner (authority) log id (padded to 32 bytes on wire). */
  ownerLogId: Uint8Array;
  /** 8-byte grant flags bitmap (`PublishGrant.grant` on-chain). */
  grant: Uint8Array;
  /** Optional max MMR height bound (defaults to 0). */
  maxHeight?: number;
  /** Optional minimum growth bound (defaults to 0). */
  minGrowth?: number;
  /** Opaque grantData committed in the grant preimage. */
  grantData: Uint8Array;
}

/**
 * Encode grant content as CBOR map keys 1–6. Left-pads log ids to 32 bytes and
 * grant flags to 8 bytes before encoding.
 *
 * @param input - Grant content fields (idtimestamp is not included)
 * @returns CBOR map bytes suitable for register-grant request bodies
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
