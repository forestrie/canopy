/**
 * Strict CBOR reader for the Forestrie wire profile — the single decoder for
 * `@forestrie/encoding`, replacing `cbor-x` on every read path.
 *
 * Definite lengths only (the wire is RFC 8949 §4.2 canonical). Maps always
 * decode to a JS `Map` with integer keys preserved as `number`/`bigint` — never
 * cbor-x's `mapsAsObjects` plain object — so `.get(label)` works uniformly and
 * the tag-259 round-trip quirk disappears. Byte strings decode to `Uint8Array`,
 * tags to {@link CborTag} (COSE_Sign1 tag 18 etc.), integers to `number` when
 * safe else `bigint`. Rejects indefinite lengths, floats, and trailing bytes —
 * anything a strict tamper-evidence consumer should reject.
 *
 * See status-2607-03-remove-cbor-x-for-scitt-cose-canonicity.
 */

/** A decoded CBOR tag (major type 6): `tag(number)` wrapping `value`. */
export class CborTag {
  constructor(
    readonly tag: number,
    readonly value: unknown,
  ) {}
}

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}

  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new Error("decodeCbor: unexpected end of input");
    }
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    // Copy so callers can't observe the shared backing buffer.
    return out.slice();
  }

  /** Read a CBOR argument for `additionalInfo` (definite forms only). */
  argument(ai: number): number | bigint {
    if (ai < 24) return ai;
    if (ai === 24) return this.u8();
    if (ai === 25) {
      this.need(2);
      const v = (this.buf[this.pos]! << 8) | this.buf[this.pos + 1]!;
      this.pos += 2;
      return v;
    }
    if (ai === 26) {
      this.need(4);
      const v =
        this.buf[this.pos]! * 0x1000000 +
        (this.buf[this.pos + 1]! << 16) +
        (this.buf[this.pos + 2]! << 8) +
        this.buf[this.pos + 3]!;
      this.pos += 4;
      return v;
    }
    if (ai === 27) {
      this.need(8);
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(this.buf[this.pos + i]!);
      this.pos += 8;
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    throw new Error(`decodeCbor: unsupported additional info ${ai}`);
  }

  value(depth: number): unknown {
    if (depth > 64) throw new Error("decodeCbor: nesting too deep");
    const ib = this.u8();
    const major = ib >> 5;
    const ai = ib & 0x1f;
    if (ai === 31) throw new Error("decodeCbor: indefinite lengths not allowed");

    switch (major) {
      case 0: // unsigned int
        return this.argument(ai);
      case 1: {
        // negative int: -1 - n
        const n = this.argument(ai);
        return typeof n === "bigint" ? -1n - n : -1 - n;
      }
      case 2: {
        // byte string
        const len = Number(this.argument(ai));
        return this.bytes(len);
      }
      case 3: {
        // text string
        const len = Number(this.argument(ai));
        return new TextDecoder("utf-8", { fatal: true }).decode(
          this.bytes(len),
        );
      }
      case 4: {
        // array
        const len = Number(this.argument(ai));
        const out: unknown[] = new Array(len);
        for (let i = 0; i < len; i++) out[i] = this.value(depth + 1);
        return out;
      }
      case 5: {
        // map → JS Map
        const len = Number(this.argument(ai));
        const m = new Map<unknown, unknown>();
        for (let i = 0; i < len; i++) {
          const k = this.value(depth + 1);
          const v = this.value(depth + 1);
          m.set(k, v);
        }
        return m;
      }
      case 6: {
        // tag
        const tag = Number(this.argument(ai));
        return new CborTag(tag, this.value(depth + 1));
      }
      case 7: {
        switch (ai) {
          case 20:
            return false;
          case 21:
            return true;
          case 22:
            return null;
          case 23:
            return undefined;
          default:
            throw new Error(
              `decodeCbor: unsupported simple/float value (ai=${ai})`,
            );
        }
      }
      default:
        throw new Error(`decodeCbor: unsupported major type ${major}`);
    }
  }
}

/**
 * Decode a single CBOR item from `bytes`. Rejects trailing bytes.
 *
 * @param bytes - Canonical CBOR
 * @returns Decoded value (Map for maps, Uint8Array for bstr, CborTag for tags)
 * @throws On malformed input, indefinite lengths, floats, or trailing data
 */
export function decodeCborDeterministic(bytes: Uint8Array): unknown {
  const r = new Reader(bytes);
  const v = r.value(0);
  if (r.pos !== bytes.length) {
    throw new Error(
      `decodeCbor: ${bytes.length - r.pos} trailing byte(s) after item`,
    );
  }
  return v;
}

/**
 * Decode a CBOR item, unwrapping a leading COSE tag (18 = COSE_Sign1, 98 =
 * COSE_Sign) if present. Convenience for COSE call sites.
 */
export function decodeCborUnwrapCose(bytes: Uint8Array): unknown {
  const v = decodeCborDeterministic(bytes);
  if (v instanceof CborTag && (v.tag === 18 || v.tag === 98)) return v.value;
  return v;
}
