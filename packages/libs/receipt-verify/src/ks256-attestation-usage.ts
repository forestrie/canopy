/**
 * Accounting for a LIST of ERC-1271 attestations over a checkpoint chain
 * (owner ruling D8): every supplied attestation is reported as used or as
 * unused with a reason, never silently ignored.
 */
import type { Ks256Attestation } from "./ks256-attestation.js";
import type {
  CheckpointLinkFailure,
  CheckpointLinkRecord,
} from "./checkpoint-link-record.js";

/**
 * Why a supplied attestation contributed nothing:
 * - `no_matching_certificate`: no link's certificate has its digest and
 *   signature hash.
 * - `not_needed`: it matched a certificate that verified without it
 *   (ecrecover, or an ES256 root also vouched).
 * - `duplicate`: another supplied attestation for the same certificate
 *   (same digest and signature hash) was used, selected or rejected first,
 *   so this one was never tried.
 */
export type Ks256AttestationUnusedReason =
  | "no_matching_certificate"
  | "not_needed"
  | "duplicate";

/**
 * Which supplied attestations carried which links. An attestation may be
 * in both `used` and `rejected` (used on earlier links, refused on a later
 * one); it is in `unused` only when it is in neither.
 */
export type Ks256AttestationUsage = {
  used: { index: number; digestHex: string; links: number[] }[];
  /** Tried for a link's certificate and failed its own checks there. */
  rejected: { index: number; digestHex: string; links: number[] }[];
  unused: {
    index: number;
    digestHex: string;
    reason: Ks256AttestationUnusedReason;
  }[];
};

/**
 * Classify each supplied attestation against the per-link records.
 *
 * @param attestations - The list the verifier was given, in order.
 * @param records - Records of the links that verified.
 * @param failure - The link the verifier refused, if any.
 */
export function summarizeKs256AttestationUsage(
  attestations: readonly Ks256Attestation[],
  records: readonly CheckpointLinkRecord[],
  failure?: CheckpointLinkFailure,
): Ks256AttestationUsage {
  const usage: Ks256AttestationUsage = { used: [], rejected: [], unused: [] };
  const seen = [...records, ...(failure !== undefined ? [failure] : [])];
  const tried = (i: number) =>
    seen.some(
      (r) =>
        r.attestationIndex === i || (r.attestationsRejected ?? []).includes(i),
    );
  attestations.forEach((a, index) => {
    const digestHex = bytesToHex(a.digest);
    const used = records
      .filter((r) => r.attestationIndex === index && r.attestationNeeded)
      .map((r) => r.index);
    const rejected = seen
      .filter((r) => (r.attestationsRejected ?? []).includes(index))
      .map((r) => r.index);
    if (used.length > 0) usage.used.push({ index, digestHex, links: used });
    if (rejected.length > 0) {
      usage.rejected.push({ index, digestHex, links: rejected });
    }
    if (used.length > 0 || rejected.length > 0) return;
    let reason: Ks256AttestationUnusedReason = "no_matching_certificate";
    if (seen.some((r) => r.attestationIndex === index)) {
      reason = "not_needed";
    } else if (
      attestations.some(
        (b, j) =>
          j !== index &&
          tried(j) &&
          bytesEqual(a.digest, b.digest) &&
          bytesEqual(a.signatureHash, b.signatureHash),
      )
    ) {
      reason = "duplicate";
    }
    usage.unused.push({ index, digestHex, reason });
  });
  return usage;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i]! ^ b[i]!;
  return x === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
