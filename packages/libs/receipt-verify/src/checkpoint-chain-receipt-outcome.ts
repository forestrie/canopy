/**
 * The typed result of {@link verifyReceiptAgainstCheckpointChain}: the
 * verdict, where it was decided, and everything a reporter needs (folded
 * links, per-link delegation records, attestation usage).
 */
import type { CheckpointChainLink } from "./checkpoint-chain.js";
import type {
  CheckpointLinkFailure,
  CheckpointLinkRecord,
} from "./checkpoint-link-record.js";
import type { Ks256AttestationUsage } from "./ks256-attestation-usage.js";

/**
 * Where a failing run stopped:
 * - `input`: the caller's inputs (no root keys, a forest genesis without a
 *   chain binding).
 * - `chain`: the checkpoint chain did not fold or a link was refused.
 * - `parse`: the receipt or idtimestamp did not parse.
 * - `anchor`: the chain folded but the receipt's leaf-derived peak is in no
 *   link (`peak_not_in_checkpoint_chain`), or the leaf is past the chain
 *   (`receipt_newer_than_checkpoint_chain`; refresh, not tamper).
 * - `delegation`: the receipt matched, but a link covering its leaf was
 *   signed under an expired certificate (`delegation_expired`).
 */
export type CheckpointChainReceiptStage =
  | "input"
  | "chain"
  | "parse"
  | "anchor"
  | "delegation";

/** Fields every outcome carries, pass or fail. */
type OutcomeCommon = {
  /** The authenticated links (the verified prefix on a chain failure). */
  links: CheckpointChainLink[];
  /** Per-link delegation facts, one per authenticated link. */
  records: CheckpointLinkRecord[];
  /** Every supplied attestation, as used or unused with a reason. */
  attestations: Ks256AttestationUsage;
};

/** A receipt anchored in a retained checkpoint chain, or why not. */
export type CheckpointChainReceiptOutcome =
  | (OutcomeCommon & {
      ok: true;
      /** Index of the newest link whose accumulator holds the peak. */
      matchedLink: number;
      /** Index of the matching peak within that link's accumulator. */
      matchedPeak: number;
    })
  | (OutcomeCommon & {
      ok: false;
      stage: CheckpointChainReceiptStage;
      /**
       * Stable reason: a {@link CheckpointLinkFailure} reason, a
       * `CheckpointChainResult` reason prefixed `checkpoint_chain_`, a
       * receipt parse reason, or one of the anchor/delegation reasons
       * above.
       */
      reason: string;
      /** Offending link index, for `chain` and `delegation`. */
      at?: number;
      /** Human detail from the chain fold, when it failed there. */
      detail?: string;
      /** The per-link verifier's refusal, when it caused a `chain` failure. */
      linkFailure?: CheckpointLinkFailure;
    });
