/**
 * Rate limit keyed by grant signer (Plan 0001 Step 7).
 * Rolling window + spike window; unit-tested only in this phase.
 */

export interface RateLimitConfig {
  /** Rolling window length in ms (e.g. 3600000 = 1 hour). */
  windowMs: number;
  /** Spike window length in ms (e.g. 60000 = 1 minute). */
  spikeWindowMs: number;
  /** Max requests per rolling window. */
  maxPerWindow: number;
  /** Max requests per spike window. */
  maxPerSpike: number;
}

export interface RateLimitState {
  /** Unix timestamps (ms) of recent requests, ascending. */
  timestamps: number[];
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

/**
 * Default config: 100/hour, 10/minute.
 */
export const DEFAULT_GRANT_SIGNER_RATE_CONFIG: RateLimitConfig = {
  windowMs: 60 * 60 * 1000,
  spikeWindowMs: 60 * 1000,
  maxPerWindow: 100,
  maxPerSpike: 10,
};

/**
 * Check rate limit and return allow/deny. Does not mutate state; caller must persist updated state.
 * State should be pruned to only timestamps within the rolling window before calling.
 */
export function checkGrantSignerRate(
  nowMs: number,
  state: RateLimitState,
  config: RateLimitConfig,
): { result: RateLimitResult; newState: RateLimitState } {
  const windowStart = nowMs - config.windowMs;
  const spikeStart = nowMs - config.spikeWindowMs;

  const inWindow = state.timestamps.filter((t) => t >= windowStart);
  const inSpike = state.timestamps.filter((t) => t >= spikeStart);

  const overWindow = inWindow.length >= config.maxPerWindow;
  const overSpike = inSpike.length >= config.maxPerSpike;

  const allowed = !overWindow && !overSpike;
  let retryAfterSeconds: number | undefined;
  if (!allowed) {
    if (overSpike && inSpike.length > 0) {
      const oldestInSpike = Math.min(...inSpike);
      retryAfterSeconds = Math.ceil(
        (oldestInSpike + config.spikeWindowMs - nowMs) / 1000,
      );
    } else if (overWindow && inWindow.length > 0) {
      const oldestInWindow = Math.min(...inWindow);
      retryAfterSeconds = Math.ceil(
        (oldestInWindow + config.windowMs - nowMs) / 1000,
      );
    }
    retryAfterSeconds = Math.max(1, retryAfterSeconds ?? 1);
  }

  const newTimestamps = [...inWindow, nowMs];
  const newState: RateLimitState = { timestamps: newTimestamps };

  return {
    result: { allowed, retryAfterSeconds },
    newState,
  };
}

/**
 * Prune state to only timestamps within the rolling window (to avoid unbounded growth).
 */
export function pruneState(
  state: RateLimitState,
  nowMs: number,
  windowMs: number,
): RateLimitState {
  const windowStart = nowMs - windowMs;
  return {
    timestamps: state.timestamps.filter((t) => t >= windowStart),
  };
}
