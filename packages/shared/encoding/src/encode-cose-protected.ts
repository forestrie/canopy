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
  const size = 1 + (hasAlg ? 1 : 0) + (hasCty ? 1 : 0);
  // Canonical map: integer keys ascending (1 < 3 < 4), size < 24 so 0xa0|size.
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
