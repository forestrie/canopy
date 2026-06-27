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
