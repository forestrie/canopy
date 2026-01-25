/**
 * @canopy/x402-settlement-types
 *
 * Shared types for x402 settlement pipeline.
 * Used by canopy-api (producer) and x402-settlement (consumer).
 */

/**
 * Settlement job emitted by canopy-api and consumed by x402-settlement worker.
 */
export interface SettlementJob {
  /** Unique identifier for this job */
  jobId: string;
  /** Authorization ID from x402 header verification */
  authId: string;
  /** Payment scheme: "exact" or "upto" */
  scheme: "exact" | "upto";
  /** Payer's Ethereum address */
  payer: `0x${string}`;
  /** Amount to charge (USD string, e.g. "$0.001") */
  amount: string;
  /** Log ID the entry was registered to */
  logId: string;
  /** Content hash of the registered statement */
  contentHash: string;
  /** Idempotency key: authId:contentHash:logId */
  idempotencyKey: string;
  /** Timestamp when job was created */
  createdAt: number;
}

/**
 * Auth state for tracking authorization health.
 */
export type AuthState = "active" | "suspect" | "blocked";

/**
 * Result of a settlement attempt.
 */
export interface SettlementResult {
  /** Whether settlement succeeded */
  ok: boolean;
  /** Transaction hash if successful */
  txHash?: string;
  /** Error message if failed */
  error?: string;
  /** Whether the error is permanent (no retry) */
  permanent?: boolean;
}
