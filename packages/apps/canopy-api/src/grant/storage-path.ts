/**
 * Grant storage path schema (Plan 0001 Step 2).
 * Content-addressable: <kind>/<hash>.cbor
 */

import { kindBytesToSegment } from "./kinds.js";

/**
 * Compute content-addressable storage path for a grant.
 * Path format: <kind>/<hash>.cbor where hash is hex-encoded SHA-256 of encoded grant bytes.
 * kind is 1 byte (uint8); converted to segment name for path.
 */
export async function grantStoragePath(
  encodedGrantBytes: Uint8Array,
  kind: Uint8Array,
): Promise<string> {
  const hashBytes = await crypto.subtle.digest("SHA-256", encodedGrantBytes);
  const hashHex = Array.from(new Uint8Array(hashBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const segment = kindBytesToSegment(kind);
  return `${segment}/${hashHex}.cbor`;
}
