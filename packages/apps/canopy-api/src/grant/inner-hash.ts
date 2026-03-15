/**
 * Inner hash for grant-sequencing (Plan 0004 subplan 01/03).
 * Matches go-univocity: inner = sha256(innerPreimage), innerPreimage = logId(32) || grant(32) || maxHeight_be(8) || minGrowth_be(8) || ownerLogId(32) || grantData.
 * ContentHash enqueued to the DO = inner (ranger then computes leafHash = H(idTimestampBE || ContentHash)).
 */

import type { Grant } from "./grant.js";

const INNER_LOG_ID_BYTES = 32;
const INNER_GRANT_FLAGS_BYTES = 32;
const U64_BYTES = 8;

function leftPad(b: Uint8Array, length: number): Uint8Array {
  if (b.length >= length) {
    return b.length === length ? b : b.slice(-length);
  }
  const out = new Uint8Array(length);
  out.set(b, length - b.length);
  return out;
}

function u64Be(n: number): Uint8Array {
  const out = new Uint8Array(U64_BYTES);
  let v = BigInt(n) & 0xffffffffffffffffn;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Grant flags in inner preimage: 32 bytes, low 8 bytes from grantFlags (go-univocity padGrant32). */
function grantFlags32(flags: Uint8Array): Uint8Array {
  const out = new Uint8Array(INNER_GRANT_FLAGS_BYTES);
  if (flags.length >= 8) {
    out.set(flags.slice(-8), 24);
  } else if (flags.length > 0) {
    out.set(flags, 32 - flags.length);
  }
  return out;
}

/**
 * Build the inner preimage (no idtimestamp). Used to compute inner hash for grant-sequencing.
 */
function innerPreimage(grant: Grant): Uint8Array {
  const logId = leftPad(grant.logId as Uint8Array, INNER_LOG_ID_BYTES);
  const flags32 = grantFlags32(grant.grantFlags as Uint8Array);
  const maxHeight = grant.maxHeight ?? 0;
  const minGrowth = grant.minGrowth ?? 0;
  const ownerLogId = leftPad(
    grant.ownerLogId as Uint8Array,
    INNER_LOG_ID_BYTES,
  );
  const grantData = grant.grantData ?? new Uint8Array(0);

  const total =
    logId.length +
    flags32.length +
    U64_BYTES * 2 +
    ownerLogId.length +
    grantData.length;
  const out = new Uint8Array(total);
  let off = 0;
  out.set(logId, off);
  off += logId.length;
  out.set(flags32, off);
  off += flags32.length;
  out.set(u64Be(maxHeight), off);
  off += U64_BYTES;
  out.set(u64Be(minGrowth), off);
  off += U64_BYTES;
  out.set(ownerLogId, off);
  off += ownerLogId.length;
  out.set(grantData, off);
  return out;
}

/**
 * Compute inner hash (32 bytes) for a grant. This is the value used as ContentHash when enqueueing for grant-sequencing.
 */
export async function innerHashFromGrant(grant: Grant): Promise<Uint8Array> {
  const preimage = innerPreimage(grant);
  const hash = await crypto.subtle.digest("SHA-256", preimage);
  return new Uint8Array(hash);
}

/**
 * Encode inner hash bytes as lowercase hex (for status URL path).
 */
export function innerHashToHex(inner: Uint8Array): string {
  return Array.from(inner)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
