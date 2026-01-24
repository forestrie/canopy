/**
 * Payer address encoding for ledger extras.
 *
 * SCITT/canopy uses extra1 as a 32-byte field carrying the payer wallet
 * address as defined by the x402 payment header.
 *
 * Canonical encoding:
 *   elem[0..19]  = raw 20-byte address
 *   elem[20..31] = zero padding (reserved for future flags)
 */

/**
 * Encode a 20-byte EVM-style address (hex string) into a 32-byte Uint8Array
 * suitable for use in extra1 / Bloom filter elements.
 *
 * Accepts either "0x"-prefixed or plain 40-hex-character strings.
 */
export function encodePayerAddressToExtra1(addressHex: string): Uint8Array {
  let hex = addressHex.trim().toLowerCase();
  if (hex.startsWith("0x")) {
    hex = hex.slice(2);
  }

  if (!/^[0-9a-f]{40}$/.test(hex)) {
    throw new Error(
      `payer address must be 20-byte hex string (40 chars), got '${addressHex}'`,
    );
  }

  const bytes = new Uint8Array(32);

  for (let i = 0; i < 20; i++) {
    const byteHex = hex.slice(i * 2, i * 2 + 2);
    bytes[i] = Number.parseInt(byteHex, 16);
  }

  // bytes[20..31] remain 0 for now (reserved for future flags/metadata).
  return bytes;
}
