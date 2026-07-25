/**
 * Per-step status for genesis one-shot coordinator forward (plan-0037).
 *
 * `inherited` is the webhook step's outcome when no explicit URL was supplied
 * but the log was bound to its univocity instance, so it takes whatever webhook
 * that instance has — including none, which means delegation works by
 * pre-emptive supply only (FOR-468).
 */
export type CoordinatorForwardStepStatus =
  | "ok"
  | "inherited"
  | "skipped"
  | "error";

export interface CoordinatorRegistrationStatus {
  publicRoot: CoordinatorForwardStepStatus;
  webhook: CoordinatorForwardStepStatus;
  /** Univocity instance the log was bound to, when one was derivable. */
  instanceKey?: string;
  detail?: string;
}
