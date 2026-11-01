/**
 * What the per-link checkpoint verifier learned about each link of a
 * retained `.sth` chain ({@link makeCheckpointLinkVerifier}). Consumers
 * (mcp-verify, forestrie-cli) report these facts; the post-match expiry
 * check ({@link checkCheckpointLinkExpiry}) reads them.
 */
import type { DelegationConstraints } from "./resolve-delegated-verify-key.js";

/**
 * Which key verified a link's checkpoint signature, and what vouched for it:
 *
 * - `es256-root`: an ES256 root key verified the checkpoint directly (no
 *   certificate, or the root signed despite one).
 * - `delegated`: the label-1000 certificate's delegated key verified it, and
 *   an ES256 root (or passkey root) vouched for the certificate.
 * - `ks256-root`: the delegated key verified it, and a KS256 root vouched for
 *   the certificate: by ecrecover, or by an ERC-1271 attestation when
 *   {@link CheckpointLinkRecord.attestationNeeded}.
 */
export type CheckpointLinkVerifiedBy =
  | "es256-root"
  | "ks256-root"
  | "delegated";

/** One authenticated link of a checkpoint chain. */
export type CheckpointLinkRecord = {
  /** Position in the supplied checkpoint list (fold order). */
  index: number;
  /** The checkpoint's SIGNED tree size (protected label -65933). */
  signedSize: bigint;
  /**
   * The delegation certificate's limits, `null` when the link carries no
   * certificate or the certificate is legacy (neither label 3 nor 4).
   */
  constraints: DelegationConstraints | null;
  verifiedBy: CheckpointLinkVerifiedBy;
  /**
   * Hex (no `0x`) of the digest of the attestation this link needed, set
   * only when {@link attestationNeeded}.
   */
  attestationUsed?: string;
  /**
   * Index, in the caller's attestation list, of the attestation made for
   * this link's certificate (digest and signature hash match), whether or
   * not the link needed it.
   */
  attestationIndex?: number;
  /**
   * Indexes of attestations made for this link's certificate that were
   * tried before {@link attestationIndex} and failed their own checks
   * (address, chain id, magic).
   */
  attestationsRejected?: number[];
  /**
   * The link verified only because of an attestation: re-resolving its
   * certificate under the same roots without one fails. Pure and offline.
   */
  attestationNeeded: boolean;
};

/** Why the per-link verifier refused a link. */
export type CheckpointLinkFailure = {
  index: number;
  /**
   * `delegation_invalid`, `delegation_range_malformed` (the certificate's
   * window is incomplete or not integers: one of labels 3/4 without the
   * other, a range label that is not a uint64, `mmrStart > mmrEnd`, or
   * labels 8/9 absent or not non-negative integers alongside a range), a
   * KS256 reason (`ks256_root_not_recovered`,
   * `ks256_attestation_*`, `delegation_not_ks256`), `delegation_out_of_range`,
   * `signature_invalid` or `proof_malformed`.
   */
  reason: string;
  /** As {@link CheckpointLinkRecord.attestationIndex}. */
  attestationIndex?: number;
  /** As {@link CheckpointLinkRecord.attestationsRejected}. */
  attestationsRejected?: number[];
};
