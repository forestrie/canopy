export interface RateLimitState {
  /** Unix timestamps (ms) of recent requests, ascending. */
  timestamps: number[];
}
