/**
 * Grant CBOR encode/decode aligned with go-univocity wire format (Plan 0004 subplan 01).
 * Map with integer keys 0–8 in order; fixed-length LogId/OwnerLogId 32 bytes,
 * GrantFlags 8 bytes (left-pad on encode). No external CBOR dependency for structure.
 */

import type { Grant } from "./types.js";
import { GRANT_VERSION } from "./types.js";

/** Wire format: keys 0–8 (go-univocity grant/cborcodec.go). */
const CBOR_KEY_IDTIMESTAMP = 0;
const CBOR_KEY_LOG_ID = 1;
const CBOR_KEY_OWNER_LOG_ID = 2;
const CBOR_KEY_GRANT_FLAGS = 3;
const CBOR_KEY_MAX_HEIGHT = 4;
const CBOR_KEY_MIN_GROWTH = 5;
const CBOR_KEY_GRANT_DATA = 6;
const CBOR_KEY_SIGNER = 7;
const CBOR_KEY_KIND = 8;

const WIRE_LOG_ID_OWNER_LOG_ID_BYTES = 32;
const WIRE_GRANT_FLAGS_BYTES = 8;
const IDTIMESTAMP_BYTES = 8;

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

/**
 * Encode a grant to CBOR bytes (go-univocity wire format: keys 0–8, fixed 32/32/8).
 * logId/ownerLogId are left-padded to 32 bytes; grantFlags to 8 bytes.
 */
export function encodeGrant(grant: Grant): Uint8Array {
  const idtimestamp =
    grant.idtimestamp.length === IDTIMESTAMP_BYTES
      ? grant.idtimestamp
      : leftPad(grant.idtimestamp as Uint8Array, IDTIMESTAMP_BYTES);
  const logId32 = leftPad(
    grant.logId as Uint8Array,
    WIRE_LOG_ID_OWNER_LOG_ID_BYTES,
  );
  const ownerLogId32 = leftPad(
    grant.ownerLogId as Uint8Array,
    WIRE_LOG_ID_OWNER_LOG_ID_BYTES,
  );
  const flags8 = leftPad(
    grant.grantFlags as Uint8Array,
    WIRE_GRANT_FLAGS_BYTES,
  );
  const maxHeight = grant.maxHeight ?? 0;
  const minGrowth = grant.minGrowth ?? 0;
  const grantData = grant.grantData ?? new Uint8Array(0);
  const signer = grant.signer ?? new Uint8Array(0);
  const kindByte =
    grant.kind instanceof Uint8Array && grant.kind.length > 0
      ? grant.kind[0]!
      : 0;

  const b: number[] = [];
  b.push(0xa9); // map(9)
  b.push(0x00, CBOR_BSTR_LEN_8);
  for (let i = 0; i < IDTIMESTAMP_BYTES; i++) b.push(idtimestamp[i]!);
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
  b.push(0x07);
  appendCborBstr(b, signer);
  b.push(0x08);
  appendCborUint(b, kindByte);
  return new Uint8Array(b);
}

/** Decode CBOR bytes (go-univocity wire format) into a Grant. Sets version = GRANT_VERSION. */
export function decodeGrant(bytes: Uint8Array): Grant {
  if (!bytes || bytes.length === 0) {
    throw new Error("Grant payload is empty");
  }
  const d = new CborDecoder(bytes);
  return d.decodeGrant();
}

class CborDecoder {
  private off = 0;
  constructor(private data: Uint8Array) {}

  private need(n: number): boolean {
    return this.off + n <= this.data.length;
  }
  private readByte(): number {
    if (!this.need(1)) throw new Error("Grant CBOR truncated");
    return this.data[this.off++]!;
  }
  private readBytes(n: number): Uint8Array {
    if (!this.need(n)) throw new Error("Grant CBOR truncated");
    const out = this.data.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }

  private decodeUint(): number {
    const b = this.readByte();
    const major = b >> 5;
    const aux = b & 0x1f;
    if (major !== 0) throw new Error("Grant: expected uint");
    if (aux < 24) return aux;
    if (aux === 24) return this.readByte();
    if (aux === 25 && this.need(2)) {
      const v = (this.data[this.off]! << 8) | this.data[this.off + 1]!;
      this.off += 2;
      return v;
    }
    if (aux === 26 && this.need(4)) {
      const v =
        (this.data[this.off]! << 24) |
        (this.data[this.off + 1]! << 16) |
        (this.data[this.off + 2]! << 8) |
        this.data[this.off + 3]!;
      this.off += 4;
      return v >>> 0;
    }
    if (aux === 27 && this.need(8)) {
      const hi =
        (this.data[this.off]! << 24) |
        (this.data[this.off + 1]! << 16) |
        (this.data[this.off + 2]! << 8) |
        this.data[this.off + 3]!;
      const lo =
        (this.data[this.off + 4]! << 24) |
        (this.data[this.off + 5]! << 16) |
        (this.data[this.off + 6]! << 8) |
        this.data[this.off + 7]!;
      this.off += 8;
      return (hi >>> 0) * 0x100000000 + (lo >>> 0);
    }
    throw new Error("Grant: unsupported uint encoding");
  }

  private decodeBstrExact(length: number): Uint8Array {
    const b = this.readByte();
    const major = b >> 5;
    const aux = b & 0x1f;
    if (major !== 2) throw new Error("Grant: expected bstr");
    let n: number;
    if (aux < 24) n = aux;
    else if (aux === 24) n = this.readByte();
    else if (aux === 25 && this.need(2)) {
      n = (this.data[this.off]! << 8) | this.data[this.off + 1]!;
      this.off += 2;
    } else throw new Error("Grant: unsupported bstr length");
    if (n !== length)
      throw new Error(`Grant: bstr length ${n}, want ${length}`);
    return this.readBytes(n);
  }

  private decodeBstrVariable(maxLen: number): Uint8Array {
    const b = this.readByte();
    const major = b >> 5;
    const aux = b & 0x1f;
    if (major !== 2) throw new Error("Grant: expected bstr");
    let n: number;
    if (aux < 24) n = aux;
    else if (aux === 24) n = this.readByte();
    else if (aux === 25 && this.need(2)) {
      n = (this.data[this.off]! << 8) | this.data[this.off + 1]!;
      this.off += 2;
    } else if (aux === 26 && this.need(4)) {
      n =
        (this.data[this.off]! << 24) |
        (this.data[this.off + 1]! << 16) |
        (this.data[this.off + 2]! << 8) |
        this.data[this.off + 3]!;
      this.off += 4;
    } else throw new Error("Grant: unsupported bstr length");
    if (n > maxLen) throw new Error(`Grant: bstr length ${n} exceeds max`);
    return n === 0 ? new Uint8Array(0) : this.readBytes(n);
  }

  decodeGrant(): Grant {
    const b = this.readByte();
    if (b >> 5 !== 5) throw new Error("Grant payload must be a CBOR map");
    const count = b & 0x1f;
    if (count !== 9) throw new Error(`Grant: expected map(9), got ${count}`);

    const readKey = (): number => {
      const k = this.decodeUint();
      return k;
    };

    if (readKey() !== CBOR_KEY_IDTIMESTAMP) throw new Error("Grant: key 0");
    const idtimestamp = this.decodeBstrExact(IDTIMESTAMP_BYTES);
    const idtimestampArr = new Uint8Array(IDTIMESTAMP_BYTES);
    idtimestampArr.set(idtimestamp);

    if (readKey() !== CBOR_KEY_LOG_ID) throw new Error("Grant: key 1");
    const logId = this.decodeBstrExact(WIRE_LOG_ID_OWNER_LOG_ID_BYTES);

    if (readKey() !== CBOR_KEY_OWNER_LOG_ID) throw new Error("Grant: key 2");
    const ownerLogId = this.decodeBstrExact(WIRE_LOG_ID_OWNER_LOG_ID_BYTES);

    if (readKey() !== CBOR_KEY_GRANT_FLAGS) throw new Error("Grant: key 3");
    const grantFlags = this.decodeBstrExact(WIRE_GRANT_FLAGS_BYTES);

    if (readKey() !== CBOR_KEY_MAX_HEIGHT) throw new Error("Grant: key 4");
    const maxHeight = this.decodeUint();

    if (readKey() !== CBOR_KEY_MIN_GROWTH) throw new Error("Grant: key 5");
    const minGrowth = this.decodeUint();

    if (readKey() !== CBOR_KEY_GRANT_DATA) throw new Error("Grant: key 6");
    const grantData = this.decodeBstrVariable(64 * 1024);

    if (readKey() !== CBOR_KEY_SIGNER) throw new Error("Grant: key 7");
    const signer = this.decodeBstrVariable(1024);
    if (signer.length === 0)
      throw new Error("Grant missing required field: signer");

    if (readKey() !== CBOR_KEY_KIND) throw new Error("Grant: key 8");
    const kindNum = this.decodeUint();
    if (kindNum > 255) throw new Error("Grant: kind exceeds 255");
    const kind = new Uint8Array([kindNum]);

    if (this.off !== this.data.length) {
      throw new Error(`Grant: ${this.data.length - this.off} trailing bytes`);
    }

    return {
      version: GRANT_VERSION,
      idtimestamp: idtimestampArr,
      logId,
      ownerLogId,
      grantFlags,
      maxHeight,
      minGrowth,
      grantData,
      signer,
      kind,
    };
  }
}
