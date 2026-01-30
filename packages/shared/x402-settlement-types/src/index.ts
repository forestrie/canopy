/**
 * @canopy/x402-settlement-types
 *
 * Shared types for x402 settlement pipeline.
 * Uses standard x402 exact scheme with EIP-3009 authorization.
 */

/**
 * EIP-3009 transferWithAuthorization parameters.
 */
export interface ExactEvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/**
 * x402 exact scheme EVM payload.
 */
export interface ExactEvmPayload {
  signature: string;
  authorization: ExactEvmAuthorization;
}

/**
 * Resource information for what's being paid for.
 */
export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

/**
 * Payment requirements option (what was accepted for payment).
 */
export interface PaymentRequirementsOption {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/**
 * x402 v2 payment payload structure.
 *
 * The v2 format includes resource and accepted requirements.
 * Legacy v1 fields are kept optional for backwards compatibility.
 */
export interface PaymentPayload {
  x402Version: 1 | 2;
  /** The scheme-specific payload (authorization + signature for exact EVM) */
  payload: ExactEvmPayload;
  /** Resource being paid for */
  resource: ResourceInfo;
  /** The accepted payment requirements */
  accepted: PaymentRequirementsOption;
  /** Protocol extensions (optional) */
  extensions?: Record<string, unknown>;
  // Legacy v1 fields (for backwards compatibility)
  scheme?: "exact";
  network?: string;
}

/**
 * Settlement job emitted by canopy-api and consumed by x402-settlement worker.
 */
export interface SettlementJob {
  /** Unique identifier for this job */
  jobId: string;
  /** Authorization ID from x402 header verification */
  authId: string;
  /** Payment scheme (currently only "exact" is supported) */
  scheme: "exact";
  /** Payer's Ethereum address */
  payer: `0x${string}`;
  /** Amount in atomic units (e.g. "1000" for $0.001 USDC) */
  amount: string;
  /** Log ID the entry was registered to */
  logId: string;
  /** Content hash of the registered statement */
  contentHash: string;
  /** Idempotency key: authId:contentHash:logId */
  idempotencyKey: string;
  /** Timestamp when job was created */
  createdAt: number;
  /** Full x402 payment payload for settlement */
  payload: PaymentPayload;
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
