/**
 * Grant storage path schema (Plan 0001 Step 2). Content-addressable: **grant/{sha256}.cbor**
 * (Forestrie-Grant v0 — no wire `kind` segment).
 */

/**
 * Compute content-addressable storage path for encoded grant bytes (v0).
 */
export async function grantStoragePath(encodedGrantBytes: Uint8Array): Promise<string> {
  const hashBytes = await crypto.subtle.digest("SHA-256", encodedGrantBytes);
  const hashHex = Array.from(new Uint8Array(hashBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `grant/${hashHex}.cbor`;
}
