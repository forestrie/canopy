/**
 * Grant flags (univocity alignment). 8-byte bitmap; GF_CREATE and GF_EXTEND
 * are bits 32 and 33 (brainstorm-0001, univocity constants.sol).
 */

/** 8-byte grantFlags; bit 32 = GF_CREATE, bit 33 = GF_EXTEND. */
export function hasCreateAndExtend(grantFlags: Uint8Array): boolean {
  if (grantFlags.length < 8) return false;
  // Bits 32 and 33 in 64-bit BE: byte index 4 holds bits 39-32
  const byte4 = grantFlags[4] ?? 0;
  return (byte4 & 0x03) === 0x03; // both bits set
}
