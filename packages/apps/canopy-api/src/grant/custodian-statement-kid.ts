/**
 * Custodian `KidFromECDSAPublicKey` (arbor services/custodian/src/kid.go): SHA-256 of the
 * uncompressed secp256r1 point (`0x04 || x || y`, 32-byte big-endian coordinates) truncated
 * to 16 bytes. Matches COSE `kid` in Sign1 from Custodian `POST /api/keys/{keyId}/sign`.
 */

import { sha256 } from "@noble/hashes/sha256";

/**
 * @param grantData64 - ES256 public key as **x || y** (64 bytes), same as bootstrap grantData.
 * @returns 16-byte kid for comparison with statement COSE protected header `kid`.
 */
export function custodianStatementKidFromXyGrantData(
  grantData64: Uint8Array,
): Uint8Array {
  if (grantData64.length !== 64) {
    throw new Error(
      `custodian statement kid: expected 64-byte x||y grantData, got ${grantData64.length}`,
    );
  }
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(grantData64.subarray(0, 32), 1);
  uncompressed.set(grantData64.subarray(32, 64), 33);
  const digest = sha256(uncompressed);
  return digest.subarray(0, 16);
}
