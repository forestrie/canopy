/** Per-step status for genesis one-shot coordinator forward (plan-0037). */
export type CoordinatorForwardStepStatus = "ok" | "skipped" | "error";

export interface CoordinatorRegistrationStatus {
  publicRoot: CoordinatorForwardStepStatus;
  webhook: CoordinatorForwardStepStatus;
  detail?: string;
}
