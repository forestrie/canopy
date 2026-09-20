/**
 * COSE protected header primitive: CBOR map with integer keys.
 * Used for statement COSE: protected = bstr containing map
 * `{ 1: alg?, 3: cty?, 4: kid }` (labels per RFC 9052 §3.1).
 *
 * `alg` and `cty` are optional for backwards compatibility with the original
 * kid-only shape; SCITT signed statements SHOULD carry both **protected** so
 * neither the algorithm nor the payload interpretation is malleable
 * (FOR-341 F1). Emission is canonical byte-by-byte (ascending integer keys,
 * shortest-form lengths) per this package's tag-free conventions — see
 * [grant-payload-canonical.ts](./grant-payload-canonical.ts).
 */

import { encodeCborBstr } from "./encode-cbor-bstr.js";
import { COSE_LABEL_ALG, COSE_LABEL_TREE_SIZE_2 } from "./cose-labels.js";
import {
  appendCborBstr,
  appendCborText,
  appendCborUint,
} from "./grant-payload-canonical.js";

/**
 * COSE header label for algorithm (alg). RFC 9052 §3.1. Alias of
 * {@link COSE_LABEL_ALG} — `cose-labels.ts` is the single source of truth
 * for this value, so it is not redeclared here.
 */
export const COSE_ALG = COSE_LABEL_ALG;
/** COSE header label for content type (cty / "content type"). RFC 9052 §3.1. */
export const COSE_CTY = 3;
/** COSE header label for key id (kid). RFC 8152. */
export const COSE_KID = 4;
/** COSE header label for CWT claims (RFC 9597). */
export const COSE_CWT_CLAIMS = 15;

/** CWT claim key: issuer (RFC 8392 §3.1.1). */
export const CWT_ISS = 1;
/** CWT claim key: subject (RFC 8392 §3.1.2). */
export const CWT_SUB = 2;
/** CWT claim key: issued-at, seconds since epoch (RFC 8392 §3.1.6). */
export const CWT_IAT = 6;

/**
 * CWT claims for protected label {@link COSE_CWT_CLAIMS} (SCITT signed
 * statements: iss + sub at minimum). `extra` carries additional
 * integer-keyed claims (e.g. cti = 7, a bstr) so future claims share the
 * same map; at least one claim must be present. Values are limited to
 * int / tstr / bstr — map-valued claims such as cnf (RFC 8747 requires a
 * map) are not yet expressible and need a pre-encoded-CBOR variant when
 * FOR-323 lands.
 */
export interface CwtClaims {
  /** Issuer (claim {@link CWT_ISS}): CWT StringOrURI. */
  iss?: string;
  /** Subject (claim {@link CWT_SUB}): CWT StringOrURI, issuer-scoped. */
  sub?: string;
  /** Issued-at (claim {@link CWT_IAT}): integer seconds since epoch. */
  iat?: number;
  /** Additional claims by integer key; must not repeat iss/sub/iat keys. */
  extra?: ReadonlyMap<number, number | string | Uint8Array>;
}

/**
 * Optional protected-header labels beyond kid.
 * All values land in the **protected** map (signed, non-malleable).
 */
export interface CoseProtectedHeaderOptions {
  /**
   * COSE algorithm id for header label {@link COSE_ALG} (e.g. ES256 = -7).
   * Integer per RFC 9053.
   */
  alg?: number;
  /**
   * Content type for header label {@link COSE_CTY}: media type text string
   * (e.g. `"application/json"`) or CoAP Content-Format unsigned integer.
   */
  cty?: string | number;
  /**
   * CWT claims for header label {@link COSE_CWT_CLAIMS} (FOR-371). Emitted
   * only when present, so claims-free output stays byte-identical to the
   * historical shapes.
   */
  cwtClaims?: CwtClaims;
  /**
   * `tree-size-2` for header label {@link COSE_LABEL_TREE_SIZE_2} (ADR-0066
   * D3 as amended): the sealed MMR size a checkpoint signs, emitted as a
   * CBOR unsigned integer (major type 0). tree-size-1 is not signed.
   */
  treeSize2?: bigint | number;
}

/** Append a CBOR integer (major type 0 for >= 0, major type 1 for < 0). */
function appendCborInt(out: number[], v: number): void {
  if (!Number.isSafeInteger(v)) {
    throw new Error(`COSE header value must be an integer, got ${v}`);
  }
  // The emitters below have no 8-byte branch; values past the 4-byte range
  // would silently truncate mod 2^32 (e.g. a milliseconds iat signing as a
  // 1986 date, or an oversized claim key aliasing an existing one). Reject.
  if (v > 0xffffffff || v < -0x100000000) {
    throw new Error(
      `COSE header integer out of 4-byte CBOR range [-2^32, 2^32-1]: ${v}`,
    );
  }
  if (v >= 0) {
    appendCborUint(out, v);
    return;
  }
  const n = -1 - v;
  if (n < 24) out.push(0x20 | n);
  else if (n <= 0xff) out.push(0x38, n);
  else if (n <= 0xffff) out.push(0x39, (n >> 8) & 0xff, n & 0xff);
  else
    out.push(
      0x3a,
      (n >>> 24) & 0xff,
      (n >> 16) & 0xff,
      (n >> 8) & 0xff,
      n & 0xff,
    );
}

/** Largest value representable as a CBOR uint64 (major type 0, ai=27). */
const MAX_UINT64 = (1n << 64n) - 1n;

/**
 * Append a CBOR unsigned integer (major type 0) in the full uint64 range,
 * shortest-form encoded per RFC 8949 §4.2.1. Unlike {@link appendCborUint}
 * (4-byte max) this has an 8-byte branch, for `tree-size-1` / `tree-size-2`
 * (ADR-0066 D3), which are MMR leaf counts that can exceed 2^32.
 *
 * @throws When `v` is negative, not an integer, or exceeds 2^64-1
 */
function appendCborUint64(out: number[], v: bigint | number): void {
  let n: bigint;
  if (typeof v === "bigint") {
    n = v;
  } else {
    if (!Number.isInteger(v)) {
      throw new Error(`COSE header uint value must be an integer, got ${v}`);
    }
    n = BigInt(v);
  }
  if (n < 0n) {
    throw new Error(`COSE header uint value must not be negative: ${n}`);
  }
  if (n > MAX_UINT64) {
    throw new Error(`COSE header uint value exceeds uint64 range: ${n}`);
  }
  if (n < 24n) {
    out.push(Number(n));
  } else if (n <= 0xffn) {
    out.push(0x18, Number(n));
  } else if (n <= 0xffffn) {
    out.push(0x19, Number((n >> 8n) & 0xffn), Number(n & 0xffn));
  } else if (n <= 0xffffffffn) {
    out.push(
      0x1a,
      Number((n >> 24n) & 0xffn),
      Number((n >> 16n) & 0xffn),
      Number((n >> 8n) & 0xffn),
      Number(n & 0xffn),
    );
  } else {
    out.push(0x1b);
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      out.push(Number((n >> shift) & 0xffn));
    }
  }
}

/**
 * Append a CBOR text string, rejecting lengths {@link appendCborText}
 * cannot represent (it has no 4-byte length branch; longer strings would
 * emit a truncated length — malformed CBOR — rather than fail).
 */
function appendBoundedCborText(out: number[], s: string): void {
  const byteLength = new TextEncoder().encode(s).length;
  if (byteLength > 0xffff) {
    throw new Error(
      `COSE header text exceeds 65535 UTF-8 bytes (${byteLength})`,
    );
  }
  appendCborText(out, s);
}

/** Encode one CBOR value permitted as a CWT claim value. */
function appendCwtClaimValue(
  out: number[],
  v: number | string | Uint8Array,
): void {
  if (typeof v === "number") appendCborInt(out, v);
  else if (typeof v === "string") appendBoundedCborText(out, v);
  else appendCborBstr(out, v);
}

/**
 * Append the CWT claims map for label {@link COSE_CWT_CLAIMS}, keys in
 * canonical order (RFC 8949 §4.2.1: bytewise lexicographic on the encoded
 * key — ascending unsigned ints first, then negatives).
 */
function appendCwtClaimsMap(out: number[], claims: CwtClaims): void {
  const entries = new Map<number, number | string | Uint8Array>();
  if (claims.iss !== undefined) entries.set(CWT_ISS, claims.iss);
  if (claims.sub !== undefined) entries.set(CWT_SUB, claims.sub);
  if (claims.iat !== undefined) entries.set(CWT_IAT, claims.iat);
  for (const [k, v] of claims.extra ?? []) {
    if (entries.has(k)) {
      throw new Error(`duplicate CWT claim key ${k} in extra`);
    }
    entries.set(k, v);
  }
  if (entries.size === 0) {
    throw new Error("cwtClaims requires at least one claim");
  }
  if (entries.size >= 24) {
    throw new Error("CWT claims map must have fewer than 24 entries");
  }
  const encodedKeys = [...entries.keys()].map((k) => {
    const bytes: number[] = [];
    appendCborInt(bytes, k);
    return { k, bytes };
  });
  encodedKeys.sort((a, b) => {
    const n = Math.min(a.bytes.length, b.bytes.length);
    for (let i = 0; i < n; i++) {
      const d = a.bytes[i]! - b.bytes[i]!;
      if (d !== 0) return d;
    }
    return a.bytes.length - b.bytes.length;
  });
  out.push(0xa0 | entries.size);
  for (const { k, bytes } of encodedKeys) {
    out.push(...bytes);
    appendCwtClaimValue(out, entries.get(k)!);
  }
}

/**
 * Serialize the COSE protected header map bytes only (not wrapped in an outer bstr).
 * This is the COSE Sign1 `[0]` bstr **payload** and the input expected by
 * {@link encodeSigStructure} (which wraps it for Sig_structure per RFC 8152).
 *
 * Without `options` the output is byte-identical to the historical kid-only
 * map `{ 4: kid }`. With `options` the map carries
 * `{ 1: alg?, 3: cty?, 4: kid, 15: cwtClaims?, -65933: treeSize2? }`.
 * Key order is canonical (shorter key encodings first, then bytewise; the
 * same order as bytewise for these keys): the existing labels (1, 3, 4, 15)
 * are each single-byte keys and stay ascending; {@link
 * COSE_LABEL_TREE_SIZE_2} encodes as the 5-byte negative int
 * `3a 00 01 01 8c` so it always sorts last.
 *
 * @param kid - Key id bytes for COSE header label {@link COSE_KID}
 * @param options - Optional protected `alg` / `cty` / `cwtClaims` /
 *   `treeSize2` labels
 * @returns CBOR map as raw bytes (canonical, tag-free)
 * @throws When `treeSize2` is not a non-negative uint64-range integer
 */
export function encodeCoseProtectedMapBytes(
  kid: Uint8Array,
  options?: CoseProtectedHeaderOptions,
): Uint8Array {
  const hasAlg = options?.alg !== undefined;
  const hasCty = options?.cty !== undefined;
  const hasClaims = options?.cwtClaims !== undefined;
  const hasTreeSize2 = options?.treeSize2 !== undefined;
  const size =
    1 +
    (hasAlg ? 1 : 0) +
    (hasCty ? 1 : 0) +
    (hasClaims ? 1 : 0) +
    (hasTreeSize2 ? 1 : 0);
  // Canonical map: integer keys ascending (1 < 3 < 4 < 15), size < 24 so 0xa0|size.
  const out: number[] = [0xa0 | size];
  if (hasAlg) {
    appendCborUint(out, COSE_ALG);
    appendCborInt(out, options.alg as number);
  }
  if (hasCty) {
    appendCborUint(out, COSE_CTY);
    const cty = options.cty as string | number;
    if (typeof cty === "string") appendBoundedCborText(out, cty);
    else appendCborUint(out, cty);
  }
  appendCborUint(out, COSE_KID);
  appendCborBstr(out, kid);
  if (hasClaims) {
    appendCborUint(out, COSE_CWT_CLAIMS);
    appendCwtClaimsMap(out, options.cwtClaims as CwtClaims);
  }
  if (hasTreeSize2) {
    appendCborInt(out, COSE_LABEL_TREE_SIZE_2);
    appendCborUint64(out, options!.treeSize2 as bigint | number);
  }
  return new Uint8Array(out);
}

/**
 * Encode protected header as CBOR bstr containing the protected map
 * (`{@link COSE_KID}: kid`, plus optional protected `alg` / `cty` /
 * `cwtClaims` / `treeSize2`).
 * Used as COSE Sign1 `[0]` in statement receipts.
 *
 * @param kid - Signer key id bound in the protected header
 * @param options - Optional protected `alg` / `cty` / `cwtClaims` /
 *   `treeSize2` labels
 * @returns CBOR bstr wrapping the protected map bytes
 */
export function encodeCoseProtectedWithKid(
  kid: Uint8Array,
  options?: CoseProtectedHeaderOptions,
): Uint8Array {
  return encodeCborBstr(encodeCoseProtectedMapBytes(kid, options));
}
