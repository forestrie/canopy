/**
 * Canonicalize a raw WebCrypto ECDSA P-256 signature to low-s.
 *
 * `crypto.subtle.sign({ name: "ECDSA", ... })` does not canonicalize its
 * output — for a given message it accepts either `s` or `n - s`
 * (ECDSA signature malleability), so a raw signature is high-s about half
 * the time. go-merklelog and the univocity contract's P-256 verifier both
 * reject high-s ES256 checkpoint signatures (FOR-568 rollout item 4), so
 * fixtures that stand in for a real checkpoint signer must normalize their
 * signatures the same way a real signer has to, rather than flaking on
 * whichever twin WebCrypto happened to produce.
 */
import { isLowS } from "@forestrie/encoding";

/** P-256 group order (matches `@forestrie/encoding`'s `isLowS`). */
const P256_N = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);

/** Replace `s` with `n - s`, leaving `r` untouched — the malleable twin of
 * whatever `signature` currently carries. */
function flipS(signature: Uint8Array): Uint8Array {
  let s = 0n;
  for (let i = 32; i < 64; i++) s = (s << 8n) | BigInt(signature[i]!);
  let flipped = P256_N - s;
  const out = new Uint8Array(signature);
  for (let i = 63; i >= 32; i--) {
    out[i] = Number(flipped & 0xffn);
    flipped >>= 8n;
  }
  return out;
}

export function toLowS(signature: Uint8Array): Uint8Array {
  return isLowS(signature) ? signature : flipS(signature);
}

/**
 * Force a signature to its high-s (malleable) twin — for tests that assert
 * the high-s rejection (FOR-568 rollout item 4) rather than avoid it.
 * `signature` must already be low-s (e.g. via {@link toLowS}); `n/2` is not
 * itself reachable from a 256-bit hash-derived nonce, so no low-s input maps
 * to itself under `flipS`.
 */
export function toHighS(signature: Uint8Array): Uint8Array {
  const s = isLowS(signature) ? signature : flipS(signature);
  return flipS(s);
}
