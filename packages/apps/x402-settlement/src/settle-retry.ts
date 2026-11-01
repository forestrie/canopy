/**
 * When to retry a settlement that failed for a transient reason (FOR-616).
 *
 * canopy-api admits a paid request on verify and enqueues the settlement
 * afterwards (mint-on-verify), so a job this worker drops is a payment canopy
 * never collects. Transient failures are therefore retried, but only while
 * the EIP-3009 authorization can still settle: past its `validBefore` the
 * token contract refuses it. canopy-api offers `maxTimeoutSeconds: 300`, so
 * the window is about five minutes from the payer's signature.
 */
import type { SettlementJob } from "@canopy/x402-settlement-types";

/** Delay before the first retry; doubles per attempt up to the cap. */
const BASE_DELAY_SECONDS = 10;
const MAX_DELAY_SECONDS = 60;
/**
 * Hard cap on deliveries, for authorizations with a distant `validBefore`.
 * Must stay below QUEUE_MAX_RETRIES + 1, or the queue drops the message
 * before the policy gives up and logs it.
 */
export const MAX_SETTLE_ATTEMPTS = 8;
/**
 * The consumer's `max_retries` in wrangler.jsonc (both lanes); keep them
 * equal. A message is delivered at most QUEUE_MAX_RETRIES + 1 times, then
 * dropped (no dead-letter queue).
 */
export const QUEUE_MAX_RETRIES = 10;
/** Delay before re-crediting a settled purchase whose credit failed. */
export const CREDIT_RETRY_DELAY_SECONDS = 30;
/**
 * Time the retried settle needs before `validBefore`: the queue's batch
 * window (30s) plus the facilitator call and mining.
 */
const EXPIRY_MARGIN_SECONDS = 45;

export type SettleRetryDecision =
  | { retry: true; delaySeconds: number }
  | { retry: false; reason: string };

/**
 * Decide whether delivery `attempts` (1 on first delivery) of `job` gets
 * another try, and after what delay.
 */
export function settleRetryDecision(
  job: SettlementJob,
  attempts: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SettleRetryDecision {
  if (attempts >= MAX_SETTLE_ATTEMPTS) {
    return { retry: false, reason: `attempt cap (${MAX_SETTLE_ATTEMPTS})` };
  }
  const delaySeconds = Math.min(
    MAX_DELAY_SECONDS,
    BASE_DELAY_SECONDS * 2 ** Math.max(0, attempts - 1),
  );
  const validBefore = Number(
    job.payload?.payload?.authorization?.validBefore ?? NaN,
  );
  if (!Number.isFinite(validBefore)) {
    return { retry: false, reason: "authorization has no validBefore" };
  }
  if (nowSeconds + delaySeconds + EXPIRY_MARGIN_SECONDS >= validBefore) {
    return {
      retry: false,
      reason: `authorization expires at ${validBefore}, before a retry could settle`,
    };
  }
  return { retry: true, delaySeconds };
}
