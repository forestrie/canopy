/**
 * Shared base64url codec (RFC 4648 §5, no padding). The unpadded form is what
 * WebAuthn `clientDataJSON.challenge` carries and what the univocity contract
 * compares (`Base64.encodeURL`); it is also the RFC 9679 thumbprint rendering.
 * Promoted from the private copy in `cose-key-thumbprint.ts` so the WebAuthn
 * challenge-binding paths and callers stop re-implementing it.
 */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const REVERSE: Int8Array = (() => {
  const out = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    out[ALPHABET.charCodeAt(i)] = i;
  }
  return out;
})();

/**
 * Encode bytes as unpadded base64url.
 *
 * @param bytes - Raw bytes to encode
 * @returns base64url string without `=` padding
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += ALPHABET[a >> 2]!;
    out += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += ALPHABET[c & 0x3f]!;
  }
  return out;
}

/**
 * Decode an unpadded base64url string to bytes.
 *
 * @param text - base64url string (no `=` padding, no `+`/`/`)
 * @returns Decoded bytes
 * @throws When the input contains characters outside the base64url alphabet,
 *   carries padding, or has an impossible length (`4n+1` symbols)
 */
export function base64UrlDecode(text: string): Uint8Array {
  if (text.length % 4 === 1) {
    throw new Error("base64url: invalid length");
  }
  const out = new Uint8Array((text.length * 3) >> 2);
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const v = code < 128 ? REVERSE[code]! : -1;
    if (v < 0) {
      throw new Error("base64url: invalid character");
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  // Trailing bits must be zero (canonical encoding; rejects e.g. "AB" ≠ "AA").
  if ((acc & ((1 << bits) - 1)) !== 0) {
    throw new Error("base64url: non-canonical trailing bits");
  }
  return out;
}
