/**
 * Strict CBOR reader for the Forestrie wire profile — the single decoder for
 * `@forestrie/encoding`, replacing `cbor-x` on every read path.
 *
 * The profile is ADR-0066 D9 "Protected-header conformance" (amendment 2,
 * 2026-09-20), quoted here because a wrong bit is a cross-verifier
 * disagreement on a signed size:
 *
 * > A checkpoint receipt's protected header MUST be deterministically encoded
 * > CBOR (RFC 8949 §4.2.1): arguments in shortest form; definite lengths only;
 * > keys in canonical order (shorter encoding first, then bytewise), which
 * > makes any duplicate keys adjacent; no duplicate keys; no tags. A string
 * > length that exceeds the remaining bytes is rejected. The map MUST consume
 * > the whole header: no trailing bytes, and a map MUST NOT declare fewer
 * > pairs than it carries. Integer keys whose magnitude exceeds int64 are
 * > rejected. A verifier MUST reject a header that is not so encoded, and MUST
 * > NOT read any value from a header whose map does not consume the whole
 * > header. A verifier MUST skip, not reject, a label it does not read whose
 * > value is any well-formed definite-length item, including major type 7:
 * > false, true, null, undefined and the other simple values 0–23, two-byte
 * > simple values 32–255, and half, single and double floats. Malformed forms
 * > are rejected: additional information 28–30, the break code 31, a two-byte
 * > simple value below 32, a float cut off by the end of the header. Tags are
 * > the one exception and stay rejected.
 *
 * The strictness applies to every decode, not only to protected headers: every
 * caller in the estate reads bytes a deterministic encoder produced. The one
 * exception found when this landed is `@forestrie/grant-builder`'s two
 * hand-rolled COSE writers (`es256-pem-grant.ts`, `ks256-wallet-grant.ts`),
 * which emit the unprotected map `{-65538: grant, -65537: idtimestamp}` in
 * that order: `3a00010001` before `3a00010000`, which is out of canonical
 * order under BOTH key-order rules. Swapping the two pairs at emit fixes it
 * and changes no signature (the unprotected header is outside the
 * Sig_structure); until then those grants are rejected here.
 *
 * Maps always decode to a JS `Map` with integer keys preserved as
 * `number`/`bigint` — never cbor-x's `mapsAsObjects` plain object — so
 * `.get(label)` works uniformly and the tag-259 round-trip quirk disappears.
 * Byte strings decode to `Uint8Array`, integers to `number` when safe else
 * `bigint`, major-type-7 simple values to {@link CborSimple} and floats to
 * {@link CborFloat} (never a plain JS `number`, so a reader can always tell a
 * float from a major-type-0 integer).
 *
 * Tags decode to {@link CborTag} at the generic level because
 * {@link decodeCborUnwrapCose} has to see the outer COSE tag (18/98) on an
 * envelope — that envelope unwrap is the only path in the estate that reads a
 * tag. {@link decodeCborDeterministicStrict} (equivalently
 * `{ tags: "reject" }`) rejects a tag anywhere in the item and is what the
 * protected-header readers use.
 *
 * Key ordering here is the ADR's **length-first, then bytewise** rule, the
 * same comparator the univocity contract applies (`compareEncodedKeys` in
 * `src/cosecbor/cosecbor.sol`), compared on the raw encoded key bytes. Go's
 * fxamacker `SortCoreDeterministic` sorts purely bytewise; the two agree for
 * every header shape the estate emits and differ only for a map mixing a
 * 1-byte key with a longer key of a lower initial byte (e.g. -1 `20` with 395
 * `19018b`) — see the divergence vector in
 * `protected-header-conformance.test.ts`.
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

/**
 * A decoded CBOR simple value (major type 7) other than false/true/null/
 * undefined: the immediate simple values 0–19 and the two-byte simple values
 * 32–255. Wrapped in a class rather than returned as a `number` so a reader
 * can never mistake a simple value for an integer.
 */
export class CborSimple {
  constructor(readonly value: number) {}
}

/**
 * A decoded CBOR float (major type 7, additional information 25/26/27: half,
 * single, double). Wrapped in a class rather than returned as a `number` so a
 * reader can never mistake a float for a major-type-0 unsigned integer — the
 * distinction a signed tree size turns on.
 */
export class CborFloat {
  constructor(readonly value: number) {}
}

/** Options for {@link decodeCborDeterministic}. */
export interface DecodeCborDeterministicOptions {
  /**
   * `"decode"` (the default) returns a tag as {@link CborTag}; `"reject"`
   * throws on a tag anywhere in the item, which is what ADR-0066 D9 requires
   * of a protected header.
   */
  tags?: "decode" | "reject";
}

/** Largest / smallest integer key a conformant header may carry (int64). */
const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;

class Reader {
  pos = 0;
  constructor(
    readonly buf: Uint8Array,
    readonly rejectTags: boolean,
  ) {}

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

  /**
   * Read a CBOR argument for `additionalInfo` in its shortest form only
   * (RFC 8949 §4.2.1 "preferred serialization"): an argument that would fit a
   * shorter encoding is rejected, as are the reserved values 28–30 (31,
   * indefinite, is rejected by the caller before we get here).
   */
  argument(ai: number): number | bigint {
    if (ai < 24) return ai;
    if (ai === 24) {
      const v = this.u8();
      if (v < 24) throw this.notShortest(v);
      return v;
    }
    if (ai === 25) {
      this.need(2);
      const v = (this.buf[this.pos]! << 8) | this.buf[this.pos + 1]!;
      this.pos += 2;
      if (v < 0x100) throw this.notShortest(v);
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
      if (v < 0x10000) throw this.notShortest(v);
      return v;
    }
    if (ai === 27) {
      this.need(8);
      let v = 0n;
      for (let i = 0; i < 8; i++)
        v = (v << 8n) | BigInt(this.buf[this.pos + i]!);
      this.pos += 8;
      if (v < 0x100000000n) throw this.notShortest(v);
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    throw new Error(`decodeCbor: malformed additional info ${ai}`);
  }

  private notShortest(v: number | bigint): Error {
    return new Error(
      `decodeCbor: argument ${v} is not in shortest form (RFC 8949 4.2.1)`,
    );
  }

  /**
   * A container declaring more items than the remaining bytes could hold
   * (every item occupies at least one byte, and a map pair at least two) is
   * rejected before any allocation, so an over-declared length can neither allocate
   * nor be silently truncated.
   */
  private checkDeclaredLength(
    declared: number | bigint,
    itemsEach: number,
    what: string,
  ): number {
    const remaining = BigInt(this.buf.length - this.pos);
    if (BigInt(declared) * BigInt(itemsEach) > remaining) {
      throw new Error(
        `decodeCbor: ${what} declares ${declared} but only ${remaining} byte(s) remain`,
      );
    }
    return Number(declared);
  }

  /** Half-precision (RFC 8949 §3.3, ai=25) to the nearest JS number. */
  private float16(): number {
    const b = this.bytes(2);
    const half = (b[0]! << 8) | b[1]!;
    const sign = half & 0x8000 ? -1 : 1;
    const exponent = (half >> 10) & 0x1f;
    const fraction = half & 0x3ff;
    if (exponent === 0) return sign * fraction * 2 ** -24;
    if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
    return sign * (fraction + 1024) * 2 ** (exponent - 25);
  }

  value(depth: number): unknown {
    if (depth > 64) throw new Error("decodeCbor: nesting too deep");
    const ib = this.u8();
    const major = ib >> 5;
    const ai = ib & 0x1f;
    if (ai === 31) {
      throw new Error(
        major === 7
          ? "decodeCbor: break code (0xff) is not a well-formed item"
          : "decodeCbor: indefinite lengths not allowed",
      );
    }

    switch (major) {
      case 0: // unsigned int
        return this.argument(ai);
      case 1: {
        // negative int: -1 - n
        const n = this.argument(ai);
        return typeof n === "bigint" ? -1n - n : -1 - n;
      }
      case 2: {
        // byte string; a length beyond the remaining bytes throws in bytes()
        const len = Number(this.argument(ai));
        return this.bytes(len);
      }
      case 3: {
        // text string
        const len = Number(this.argument(ai));
        return new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: false,
        }).decode(this.bytes(len));
      }
      case 4: {
        // array
        const len = this.checkDeclaredLength(this.argument(ai), 1, "array");
        const out: unknown[] = new Array(len);
        for (let i = 0; i < len; i++) out[i] = this.value(depth + 1);
        return out;
      }
      case 5:
        return this.map(ai, depth);
      case 6: {
        // tag
        const tag = Number(this.argument(ai));
        if (this.rejectTags) {
          throw new Error(`decodeCbor: tag ${tag} is not allowed here`);
        }
        return new CborTag(tag, this.value(depth + 1));
      }
      case 7: {
        if (ai < 20) return new CborSimple(ai);
        switch (ai) {
          case 20:
            return false;
          case 21:
            return true;
          case 22:
            return null;
          case 23:
            return undefined;
          case 24: {
            // Two-byte simple value: 32–255 only; 0–31 in this form are not
            // well formed (RFC 8949 §3.3).
            const v = this.u8();
            if (v < 32) {
              throw new Error(
                `decodeCbor: two-byte simple value ${v} below 32 is malformed`,
              );
            }
            return new CborSimple(v);
          }
          case 25:
            return new CborFloat(this.float16());
          case 26: {
            const b = this.bytes(4);
            return new CborFloat(new DataView(b.buffer).getFloat32(0));
          }
          case 27: {
            const b = this.bytes(8);
            return new CborFloat(new DataView(b.buffer).getFloat64(0));
          }
          default:
            // 28–30 are reserved and not well formed.
            throw new Error(
              `decodeCbor: malformed additional info ${ai} (major type 7)`,
            );
        }
      }
      default:
        throw new Error(`decodeCbor: unsupported major type ${major}`);
    }
  }

  /**
   * Decode a map, enforcing canonical key order on the raw encoded key bytes:
   * shorter encoding first, then bytewise. The order makes any duplicate keys
   * adjacent, so an equal neighbour is a duplicate and is rejected — the
   * previous `m.set(k, v)` let a later duplicate silently win.
   */
  private map(ai: number, depth: number): Map<unknown, unknown> {
    const pairs = this.checkDeclaredLength(this.argument(ai), 2, "map");
    const m = new Map<unknown, unknown>();
    let previousKey: Uint8Array | null = null;
    for (let i = 0; i < pairs; i++) {
      const keyStart = this.pos;
      const key = this.value(depth + 1);
      const keyBytes = this.buf.subarray(keyStart, this.pos);
      checkKeyMagnitude(key);
      if (previousKey !== null) {
        const order = compareEncodedKeys(previousKey, keyBytes);
        if (order === 0) {
          throw new Error(`decodeCbor: duplicate map key ${describeKey(key)}`);
        }
        if (order > 0) {
          throw new Error(
            `decodeCbor: map key ${describeKey(key)} is out of canonical order`,
          );
        }
      }
      previousKey = keyBytes;
      m.set(key, this.value(depth + 1));
    }
    return m;
  }
}

/**
 * Canonical key order (RFC 8949 §4.2.1 length-first variant, the rule
 * ADR-0066 D9 states and `compareEncodedKeys` in univocity's
 * `src/cosecbor/cosecbor.sol` implements): the shorter encoding sorts first,
 * equal lengths compare bytewise.
 */
function compareEncodedKeys(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

/**
 * Integer keys of either sign whose magnitude exceeds int64 are rejected: a
 * 2^63 key would otherwise read as a negative label in a decoder that wraps,
 * which is a disagreement about which label a value sits under.
 */
function checkKeyMagnitude(key: unknown): void {
  if (typeof key !== "bigint") return;
  if (key > INT64_MAX || key < INT64_MIN) {
    throw new Error(
      `decodeCbor: integer map key ${key} exceeds int64 magnitude`,
    );
  }
}

function describeKey(key: unknown): string {
  return typeof key === "string" ? JSON.stringify(key) : String(key);
}

/**
 * Decode a single CBOR item from `bytes` under the ADR-0066 D9 profile
 * (see the module doc): shortest-form arguments, definite lengths, canonical
 * key order, no duplicate keys, no trailing bytes.
 *
 * @param bytes - Deterministically encoded CBOR
 * @param options - `{ tags: "reject" }` to reject a tag anywhere in the item
 * @returns Decoded value (Map for maps, Uint8Array for bstr, CborTag for tags,
 *   CborSimple / CborFloat for the major-type-7 forms that are not
 *   false/true/null/undefined)
 * @throws On any non-canonical or malformed encoding, or trailing data
 */
export function decodeCborDeterministic(
  bytes: Uint8Array,
  options?: DecodeCborDeterministicOptions,
): unknown {
  const r = new Reader(bytes, options?.tags === "reject");
  const v = r.value(0);
  if (r.pos !== bytes.length) {
    throw new Error(
      `decodeCbor: ${bytes.length - r.pos} trailing byte(s) after item`,
    );
  }
  return v;
}

/**
 * {@link decodeCborDeterministic} with tags rejected anywhere in the item, as
 * ADR-0066 D9 requires of a protected header ("Tags are the one exception and
 * stay rejected"). Protected-header readers use this; only
 * {@link decodeCborUnwrapCose} needs the tag-decoding form.
 */
export function decodeCborDeterministicStrict(bytes: Uint8Array): unknown {
  return decodeCborDeterministic(bytes, { tags: "reject" });
}

/**
 * Decode a CBOR item, unwrapping a leading COSE tag (18 = COSE_Sign1, 98 =
 * COSE_Sign) if present. Convenience for COSE call sites, and the only path in
 * the estate that reads a tag: the tag sits on the envelope, never inside a
 * protected header.
 */
export function decodeCborUnwrapCose(bytes: Uint8Array): unknown {
  const v = decodeCborDeterministic(bytes);
  if (v instanceof CborTag && (v.tag === 18 || v.tag === 98)) return v.value;
  return v;
}
