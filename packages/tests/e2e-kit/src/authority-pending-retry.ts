/**
 * Waiting out canopy's 409 `authority-pending`. canopy admits writes to a log
 * only once univocity reports it anchored on chain (protocol ADR-0070,
 * canopy `src/scrapi/log-admission.ts`). A log created moments ago anchors
 * when its owner next publishes a checkpoint, so a suite that creates a log
 * and then writes to it must wait, as `forestrie` CLI clients do. Any other
 * answer, `authority-conflict` included, is the caller's to judge.
 */
import { decodeCborDeterministic } from "@forestrie/encoding";
import type { APIResponse } from "@playwright/test";

/**
 * Wait budget for one log to anchor: about one owner checkpoint publish on
 * Lane A (event-driven, typically 10-60 s), with room for one redelivery.
 */
export const E2E_AUTHORITY_ANCHOR_WAIT_MS = 180_000;

/** canopy's problem type for a claimed log that is not yet anchored. */
const AUTHORITY_PENDING = "authority-pending";

/** Pacing when a pending answer carries no usable `Retry-After`. */
const DEFAULT_RETRY_AFTER_MS = 30_000;

/**
 * Sends `post` until its answer is anything but 409 `authority-pending`, or
 * the budget is spent, and returns the last answer.
 *
 * @param opts.maxWaitMs total time spent waiting between attempts
 *   (default {@link E2E_AUTHORITY_ANCHOR_WAIT_MS}).
 * @param opts.sleep injectable for tests.
 */
export async function retryWhileAuthorityPending(
  post: () => Promise<APIResponse>,
  opts: { maxWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<APIResponse> {
  const maxWaitMs = opts.maxWaitMs ?? E2E_AUTHORITY_ANCHOR_WAIT_MS;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let waited = 0;
  for (;;) {
    const res = await post();
    if (!(await isAuthorityPending(res)) || waited >= maxWaitMs) return res;
    const wait = Math.min(retryAfterMs(res), maxWaitMs - waited);
    await sleep(wait);
    waited += wait;
  }
}

async function isAuthorityPending(res: APIResponse): Promise<boolean> {
  if (res.status() !== 409) return false;
  try {
    const problem = decodeCborDeterministic(new Uint8Array(await res.body()));
    const type =
      problem instanceof Map
        ? problem.get("type")
        : (problem as Record<string, unknown> | null)?.type;
    return type === AUTHORITY_PENDING;
  } catch {
    return false;
  }
}

function retryAfterMs(res: APIResponse): number {
  const seconds = Number(res.headers()["retry-after"]);
  return Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : DEFAULT_RETRY_AFTER_MS;
}
