/**
 * Log id normalization between URL paths, wire CBOR, and shard routing.
 *
 * Aligns with [arbor sealer](https://github.com/forestrie/arbor/blob/main/services/sealer/)
 * wire log id conventions and trust-root CBOR `logId` bytes.
 */

/**
 * Normalize a log id path segment or wire value to 32-char lowercase hex.
 *
 * Accepts canonical UUID (with or without dashes) or 64-char wire hex (uses
 * the right-aligned 16-byte UUID suffix).
 *
 * @param logId - Raw log id string from path or API.
 * @returns 32-char lowercase hex.
 * @throws When the input is not UUID or valid hex.
 */
export function normalizeLogIdToHex32(logId: string): string {
  const trimmed = logId.trim();
  const noDash = trimmed.replace(/-/g, "").toLowerCase();

  if (noDash.length === 32 && /^[0-9a-f]+$/.test(noDash)) {
    return noDash;
  }

  if (noDash.length === 64 && /^[0-9a-f]+$/.test(noDash)) {
    return noDash.slice(-32);
  }

  throw new Error("logId must be a UUID or 32 hex characters");
}

/**
 * Encode 16-byte wire log id from normalized 32-char hex.
 *
 * @param hex32 - Normalized log id hex.
 * @returns 16-byte wire form for trust-root CBOR.
 */
export function hex32ToWireLogIdBytes(hex32: string): Uint8Array {
  const h = normalizeLogIdToHex32(hex32);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Format normalized hex32 as canonical UUID for shard hash input.
 *
 * @param hex32 - Normalized log id hex.
 * @returns UUID string with dashes.
 */
export function hex32ToCanonicalUuid(hex32: string): string {
  const h = normalizeLogIdToHex32(hex32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Normalize CBOR `logId` wire bytes to 32-char hex (arbor wire convention).
 *
 * @param wire - 16- or 32-byte wire log id from CBOR bodies.
 * @returns 32-char lowercase hex.
 * @throws When wire length is unsupported.
 */
export function logIdWireBytesToHex32(wire: Uint8Array): string {
  if (wire.length === 16) {
    return Array.from(wire)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  if (wire.length === 32) {
    const asText = new TextDecoder().decode(wire);
    if (/^[0-9a-fA-F]{32}$/.test(asText)) {
      return asText.toLowerCase();
    }
    return Array.from(wire.slice(-16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  throw new Error("logId wire bytes must be 16 or 32 bytes");
}
