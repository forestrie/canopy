/**
 * RFC 9679 COSE Key Thumbprint URI for EC2 P-256 keys.
 * Thumbprint input is the deterministic CBOR of the required COSE_Key
 * members only — `{1: kty(EC2), -1: crv(P-256), -2: x, -3: y}` — hashed
 * with SHA-256 and rendered as `urn:ietf:params:oauth:ckt:sha-256:<b64url>`.
 * Used as the opt-in `iss` form for statement CWT claims (FOR-371,
 * devdocs ADR-0055).
 */

const CKT_URI_PREFIX = "urn:ietf:params:oauth:ckt:sha-256:";
const P256_COORD_BYTES = 32;

const BASE64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += BASE64URL[a >> 2]!;
    out += BASE64URL[((a & 0x03) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += BASE64URL[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += BASE64URL[c & 0x3f]!;
  }
  return out;
}

/**
 * Compute the RFC 9679 COSE Key Thumbprint URI for a P-256 public key.
 *
 * @param xOrXy - x coordinate (32 bytes), or uncompressed `x||y` (64 bytes)
 *   when `y` is omitted
 * @param y - y coordinate (32 bytes) when `xOrXy` is the x coordinate
 * @returns `urn:ietf:params:oauth:ckt:sha-256:<base64url(sha-256(CBOR))>`
 */
export async function coseKeyThumbprintUriP256(
  xOrXy: Uint8Array,
  y?: Uint8Array,
): Promise<string> {
  let xc: Uint8Array;
  let yc: Uint8Array;
  if (y === undefined) {
    if (xOrXy.length !== 2 * P256_COORD_BYTES) {
      throw new Error(
        `uncompressed x||y must be ${2 * P256_COORD_BYTES} bytes, got ${xOrXy.length}`,
      );
    }
    xc = xOrXy.subarray(0, P256_COORD_BYTES);
    yc = xOrXy.subarray(P256_COORD_BYTES);
  } else {
    xc = xOrXy;
    yc = y;
  }
  if (xc.length !== P256_COORD_BYTES || yc.length !== P256_COORD_BYTES) {
    throw new Error(`P-256 coordinates must be ${P256_COORD_BYTES} bytes`);
  }

  // Deterministic CBOR of the required EC2 members (RFC 9679 §3.2):
  // {1: 2, -1: 1, -2: x, -3: y} with bytewise-ordered keys.
  const input = new Uint8Array(11 + 2 * P256_COORD_BYTES);
  input.set([0xa4, 0x01, 0x02, 0x20, 0x01, 0x21, 0x58, 0x20], 0);
  input.set(xc, 8);
  input.set([0x22, 0x58, 0x20], 8 + P256_COORD_BYTES);
  input.set(yc, 11 + P256_COORD_BYTES);

  const inputBuffer = input.buffer.slice(
    input.byteOffset,
    input.byteOffset + input.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", inputBuffer);
  return CKT_URI_PREFIX + base64Url(new Uint8Array(digest));
}
