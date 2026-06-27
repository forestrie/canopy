export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}
