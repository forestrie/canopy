import { grantDataToBytes } from "@forestrie/grant-builder";
import type { Grant } from "@forestrie/grant-builder";
import { toPaddedWire32 } from "./uuid-bytes.js";

const GRANT_FLAGS_32_BYTES = 32;
const U64_BYTES = 8;

function u64Be(n: number): Uint8Array {
  const out = new Uint8Array(U64_BYTES);
  let v = BigInt(n) & 0xffffffffffffffffn;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function grantFlags32(flags: Uint8Array): Uint8Array {
  const out = new Uint8Array(GRANT_FLAGS_32_BYTES);
  if (flags.length >= 8) {
    out.set(flags.slice(-8), 24);
  } else if (flags.length > 0) {
    out.set(flags, 32 - flags.length);
  }
  return out;
}

function grantCommitmentPreimage(grant: Grant): Uint8Array {
  const logId = toPaddedWire32(grant.logId);
  const flags32 = grantFlags32(grant.grant);
  const maxHeight = grant.maxHeight ?? 0;
  const minGrowth = grant.minGrowth ?? 0;
  const ownerLogId = toPaddedWire32(grant.ownerLogId);
  const grantData = grantDataToBytes(grant.grantData ?? new Uint8Array(0));

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

export async function grantCommitmentHashFromGrant(
  grant: Grant,
): Promise<Uint8Array> {
  const preimage = grantCommitmentPreimage(grant);
  const hash = await crypto.subtle.digest("SHA-256", preimage as BufferSource);
  return new Uint8Array(hash);
}
