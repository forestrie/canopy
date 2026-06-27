/**
 * Webhook retry ladder parsed from Worker environment.
 *
 * Used by {@link DelegationStoreDO} alarm-driven delivery retries after
 * {@link deliverSignedWebhook} failures.
 */

import type { Env } from "../env.js";

/** Parsed retry policy for webhook delivery attempts. */
export interface WebhookRetryConfig {
  retryLadder: number[];
  retryScaleMs: number;
}

/** Default multipliers when {@link Env.WEBHOOK_RETRY_LADDER} is unset. */
const DEFAULT_LADDER = [1, 2, 4, 8];

/** Default scale when {@link Env.WEBHOOK_RETRY_SCALE_MS} is unset. */
const DEFAULT_SCALE_MS = 1000;

/**
 * Parse webhook retry settings from environment bindings.
 *
 * @param env - Worker bindings.
 * @returns Ladder multipliers and base scale in milliseconds.
 */
export function parseRetryConfig(env: Env): WebhookRetryConfig {
  const ladderRaw = env.WEBHOOK_RETRY_LADDER?.trim();
  let retryLadder = DEFAULT_LADDER;
  if (ladderRaw) {
    try {
      const parsed = JSON.parse(ladderRaw) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((n) => typeof n === "number" && n > 0)
      ) {
        retryLadder = parsed;
      }
    } catch {
      // keep defaults
    }
  }

  const scaleRaw = env.WEBHOOK_RETRY_SCALE_MS?.trim();
  const scaleParsed = scaleRaw
    ? Number.parseInt(scaleRaw, 10)
    : DEFAULT_SCALE_MS;
  const retryScaleMs =
    Number.isFinite(scaleParsed) && scaleParsed > 0
      ? scaleParsed
      : DEFAULT_SCALE_MS;

  return { retryLadder, retryScaleMs };
}

/**
 * Compute wait time before a webhook retry attempt.
 *
 * @param config - Parsed retry policy.
 * @param ladderIndex - Zero-based index into retryLadder.
 * @param random - RNG for jitter (default Math.random).
 * @returns Delay in milliseconds before next attempt.
 */
export function computeRetryWaitMs(
  config: WebhookRetryConfig,
  ladderIndex: number,
  random = Math.random,
): number {
  const multiplier = config.retryLadder[ladderIndex] ?? 0;
  const jitter = random() * (config.retryScaleMs / 2);
  return multiplier * config.retryScaleMs + jitter;
}
