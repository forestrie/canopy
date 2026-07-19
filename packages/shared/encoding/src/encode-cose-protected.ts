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
import {
  appendCborBstr,
  appendCborText,
  appendCborUint,
} from "./grant-payload-canonical.js";

/** COSE header label for algorithm (alg). RFC 9052 §3.1. */
export const COSE_ALG = 1;
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
 * integer-keyed claims (e.g. cnf = 8) so future claims share the same map;
 * at least one claim must be present.
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
}

/** Append a CBOR integer (major type 0 for >= 0, major type 1 for < 0). */
function appendCborInt(out: number[], v: number): void {
  if (!Number.isSafeInteger(v)) {
    throw new Error(`COSE header value must be an integer, got ${v}`);
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

/** Encode one CBOR value permitted as a CWT claim value. */
function appendCwtClaimValue(
  out: number[],
  v: number | string | Uint8Array,
): void {
  if (typeof v === "number") appendCborInt(out, v);
  else if (typeof v === "string") appendCborText(out, v);
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
 * `{ 1: alg?, 3: cty?, 4: kid }` with canonical ascending integer keys.
 *
 * @param kid - Key id bytes for COSE header label {@link COSE_KID}
 * @param options - Optional protected `alg` / `cty` labels
 * @returns CBOR map as raw bytes (canonical, tag-free)
 */
export function encodeCoseProtectedMapBytes(
  kid: Uint8Array,
  options?: CoseProtectedHeaderOptions,
): Uint8Array {
  const hasAlg = options?.alg !== undefined;
  const hasCty = options?.cty !== undefined;
  const hasClaims = options?.cwtClaims !== undefined;
  const size = 1 + (hasAlg ? 1 : 0) + (hasCty ? 1 : 0) + (hasClaims ? 1 : 0);
  // Canonical map: integer keys ascending (1 < 3 < 4 < 15), size < 24 so 0xa0|size.
  const out: number[] = [0xa0 | size];
  if (hasAlg) {
    appendCborUint(out, COSE_ALG);
    appendCborInt(out, options.alg as number);
  }
  if (hasCty) {
    appendCborUint(out, COSE_CTY);
    const cty = options.cty as string | number;
    if (typeof cty === "string") appendCborText(out, cty);
    else appendCborUint(out, cty);
  }
  appendCborUint(out, COSE_KID);
  appendCborBstr(out, kid);
  if (hasClaims) {
    appendCborUint(out, COSE_CWT_CLAIMS);
    appendCwtClaimsMap(out, options.cwtClaims as CwtClaims);
  }
  return new Uint8Array(out);
}

/**
 * Encode protected header as CBOR bstr containing the protected map
 * (`{@link COSE_KID}: kid`, plus optional protected `alg` / `cty`).
 * Used as COSE Sign1 `[0]` in statement receipts.
 *
 * @param kid - Signer key id bound in the protected header
 * @param options - Optional protected `alg` / `cty` labels
 * @returns CBOR bstr wrapping the protected map bytes
 */
export function encodeCoseProtectedWithKid(
  kid: Uint8Array,
  options?: CoseProtectedHeaderOptions,
): Uint8Array {
  return encodeCborBstr(encodeCoseProtectedMapBytes(kid, options));
}
