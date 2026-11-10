/**
 * Comparable identity of a stored public root. The `public_roots` table
 * keeps ES256 roots two ways: alg `"ES256"` with x and y, or alg `"-7"`
 * with the 64-byte x||y in `x`. KS256 roots are alg `"-65799"` with the
 * 20-byte address in `x`. Store-once (devdocs ADR-0075 decision 3) compares
 * roots by this identity, so the same key sent in either ES256 shape is the
 * same root.
 */

import { COSE_ALG_ES256, COSE_ALG_KS256 } from "./types/trust-root-response.js";

/**
 * @param alg the stored `alg` column: `"ES256"`, `"-7"` or `"-65799"`.
 * @returns `"<ES256|KS256>:<lowercase hex key>"`; an unknown alg yields a
 *   value that equals only the same unknown row.
 */
export function storedRootKey(
  alg: string,
  x: ArrayBuffer | Uint8Array,
  y: ArrayBuffer | Uint8Array,
): string {
  const xs = new Uint8Array(x);
  if (alg === "ES256") return `ES256:${hex(xs)}${hex(new Uint8Array(y))}`;
  const algInt = Number(alg);
  if (algInt === COSE_ALG_ES256) return `ES256:${hex(xs)}`;
  if (algInt === COSE_ALG_KS256) return `KS256:${hex(xs)}`;
  return `${alg}:${hex(xs)}:${hex(new Uint8Array(y))}`;
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
