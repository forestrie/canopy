/**
 * Univocity leaf commitment for grants (Plan 0004 subplan 01/03).
 * Ranger computes leafHash = H(idTimestampBE || ContentHash); ContentHash = inner (grant).
 * So leafHash = SHA-256(idTimestampBE || inner).
 */

const IDTIMESTAMP_BYTES = 8;

function writeU64BE(out: Uint8Array, offset: number, value: bigint): void {
  let v = value & 0xffffffffffffffffn;
  for (let i = 7; i >= 0; i--) {
    out[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

/**
 * Compute the univocity leaf hash for a grant entry.
 * leafHash = SHA-256(idTimestampBE || inner).
 *
 * @param idtimestamp - 8-byte idtimestamp (big-endian) or bigint
 * @param inner - 32-byte inner hash (ContentHash)
 * @returns 32-byte leaf hash
 */
export async function univocityLeafHash(
  idtimestamp: bigint | Uint8Array,
  inner: Uint8Array,
): Promise<Uint8Array> {
  const idtimestampBytes = new Uint8Array(IDTIMESTAMP_BYTES);
  if (typeof idtimestamp === "bigint") {
    writeU64BE(idtimestampBytes, 0, idtimestamp);
  } else {
    if (idtimestamp.length < IDTIMESTAMP_BYTES) {
      throw new Error("idtimestamp must be at least 8 bytes");
    }
    idtimestampBytes.set(
      idtimestamp.length > IDTIMESTAMP_BYTES
        ? idtimestamp.slice(-IDTIMESTAMP_BYTES)
        : idtimestamp,
    );
  }
  const preimage = new Uint8Array(idtimestampBytes.length + inner.length);
  preimage.set(idtimestampBytes);
  preimage.set(inner, idtimestampBytes.length);
  const hash = await crypto.subtle.digest("SHA-256", preimage);
  return new Uint8Array(hash);
}
