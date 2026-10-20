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
 * - `no_matching_certificate`: no verified link's certificate has its
 *   digest and signature hash.
 * - `not_needed`: it matched a certificate that verified without it
 *   (ecrecover, or an ES256 root also vouched).
 * - `rejected`: it matched the certificate of the link that failed (wrong
 *   address, chain or magic).
 */
export type Ks256AttestationUnusedReason =
  | "no_matching_certificate"
  | "not_needed"
  | "rejected";

/** Which supplied attestations carried which links. */
export type Ks256AttestationUsage = {
  used: { index: number; digestHex: string; links: number[] }[];
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
  const usage: Ks256AttestationUsage = { used: [], unused: [] };
  attestations.forEach((a, index) => {
    const digestHex = bytesToHex(a.digest);
    const links = records
      .filter((r) => r.attestationIndex === index && r.attestationNeeded)
      .map((r) => r.index);
    if (links.length > 0) {
      usage.used.push({ index, digestHex, links });
      return;
    }
    const reason: Ks256AttestationUnusedReason =
      failure?.attestationIndex === index
        ? "rejected"
        : records.some((r) => r.attestationIndex === index)
          ? "not_needed"
          : "no_matching_certificate";
    usage.unused.push({ index, digestHex, reason });
  });
  return usage;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
