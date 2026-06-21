import type { Env } from "../env.js";

export interface WebhookRetryConfig {
  retryLadder: number[];
  retryScaleMs: number;
}

const DEFAULT_LADDER = [1, 2, 4, 8];
const DEFAULT_SCALE_MS = 1000;

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

/** Wait before retry attempt index n (0-based into retryLadder). */
export function computeRetryWaitMs(
  config: WebhookRetryConfig,
  ladderIndex: number,
  random = Math.random,
): number {
  const multiplier = config.retryLadder[ladderIndex] ?? 0;
  const jitter = random() * (config.retryScaleMs / 2);
  return multiplier * config.retryScaleMs + jitter;
}
