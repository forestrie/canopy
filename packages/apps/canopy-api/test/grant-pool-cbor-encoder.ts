/**
 * Grant request CBOR — re-exports canonical encoder from @canopy/encoding.
 * Helpers for tests that need hex ↔ signer bytes (matching k6 / generate-grant-pool).
 */

import { encodeGrantRequest } from "@canopy/encoding";

export { encodeGrantRequest };

/**
 * Encode grant content as CBOR (Plan 0006: keys 1–8 only).
 */
export function encodeGrantRequestCbor(
  logId: Uint8Array,
  ownerLogId: Uint8Array,
  grantFlags: Uint8Array,
  grantData: Uint8Array,
  signer: Uint8Array,
  kind: Uint8Array,
  options?: {
    maxHeight?: number;
    minGrowth?: number;
  },
): Uint8Array {
  return encodeGrantRequest({
    logId,
    ownerLogId,
    grantFlags,
    maxHeight: options?.maxHeight,
    minGrowth: options?.minGrowth,
    grantData,
    signer,
    kind,
  });
}

/** Hex string (64 chars) -> 32 bytes, matching k6 signerToBytes for hex. */
export function hexToSignerBytes(hex: string): Uint8Array {
  const s = hex.trim();
  if (s.length !== 64 || !/^[0-9a-fA-F]+$/.test(s)) {
    throw new Error(`Invalid signer hex length or chars: ${s.length}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 32 bytes -> 64-char hex, matching generate-grant-pool pool payload. */
export function signerBytesToHex(bytes: Uint8Array): string {
  if (bytes.length !== 32)
    throw new Error(`Expected 32 bytes, got ${bytes.length}`);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
