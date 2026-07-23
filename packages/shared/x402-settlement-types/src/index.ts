/**
 * @canopy/x402-settlement-types — shared x402 settlement pipeline shapes.
 *
 * Jobs flow canopy-api → Cloudflare Queue → `@canopy/x402-settlement` worker.
 * Architecture:
 * [ARC-0015](https://github.com/forestrie/devdocs/blob/main/arc/arc-0015-x402-settlement-architecture.md).
 * Uses standard x402 **exact** scheme with EIP-3009 `transferWithAuthorization`.
 */

/** EIP-3009 `transferWithAuthorization` fields from the x402 exact EVM payload. */
export interface ExactEvmAuthorization {
  /** Payer EOA (`0x` + 40 hex). */
  from: string;
  /** Payee address (settlement recipient). */
  to: string;
  /** Amount in token atomic units (decimal string). */
  value: string;
  /** Unix timestamp after which authorization is valid. */
  validAfter: string;
  /** Unix timestamp before which authorization expires. */
  validBefore: string;
  /** EIP-3009 nonce (32-byte hex). */
  nonce: string;
}

/** x402 exact-scheme EVM payload (authorization + secp256k1 signature). */
export interface ExactEvmPayload {
  /** EIP-712 or raw authorization signature hex. */
  signature: string;
  /** Signed EIP-3009 authorization struct. */
  authorization: ExactEvmAuthorization;
}

/** SCRAPI resource metadata embedded in the payment payload. */
export interface ResourceInfo {
  /** Paid resource URL (typically the register endpoint). */
  url: string;
  /** Optional human-readable description. */
  description?: string;
  /** Optional MIME type of the paid resource. */
  mimeType?: string;
}

/** Accepted payment requirements option from the x402 negotiation. */
export interface PaymentRequirementsOption {
  /** Payment scheme (Forestrie uses `"exact"`). */
  scheme: "exact";
  /** Chain/network identifier (e.g. `base-sepolia`). */
  network: string;
  /** Required amount in atomic units. */
  amount: string;
  /** ERC-20 asset contract address. */
  asset: string;
  /** Settlement payee address. */
  payTo: string;
  /** Optional authorization timeout in seconds. */
  maxTimeoutSeconds?: number;
  /** Scheme-specific extension fields. */
  extra?: Record<string, unknown>;
}

/**
 * x402 v2 payment payload (authorization + resource + accepted terms).
 * Legacy v1 top-level fields remain optional for backwards compatibility.
 */
export interface PaymentPayload {
  /** x402 protocol version (1 or 2). */
  x402Version: 1 | 2;
  /** Scheme-specific payload (exact EVM authorization + signature). */
  payload: ExactEvmPayload;
  /** Resource being paid for. */
  resource: ResourceInfo;
  /** Accepted payment requirements from the 402 response. */
  accepted: PaymentRequirementsOption;
  /** Optional protocol extensions. */
  extensions?: Record<string, unknown>;
  /** Legacy v1: payment scheme. */
  scheme?: "exact";
  /** Legacy v1: network identifier. */
  network?: string;
}

/**
 * What a settled x402 payment purchased. Onboard and grant issuance are the
 * live SKUs (coarse, deliberate events, mint-on-verify — see devdocs
 * plan-2607-38). `statement` is the withdrawn per-registration model, retained
 * so a revived producer has a name.
 */
export type SettlementKind = "onboard" | "grant" | "statement";

/**
 * Settlement job emitted by canopy-api and consumed by x402-settlement worker.
 * Idempotency is enforced on {@link SettlementJob.idempotencyKey}.
 *
 * The settlement worker settles purely from `payload.accepted`, `payer`,
 * `amount` and `idempotencyKey`; the remaining fields are the economic record
 * for the fee ledger (FOR-84) and are not load-bearing for on-chain settlement.
 */
export interface SettlementJob {
  /** Unique job identifier (UUID). */
  jobId: string;
  /** What this payment purchased. */
  kind: SettlementKind;
  /** Authorization id derived from the payment (per-payer failure/block state). */
  authId: string;
  /** Payment scheme (currently only `"exact"`). */
  scheme: "exact";
  /** Payer Ethereum address. */
  payer: `0x${string}`;
  /** Amount in atomic units (e.g. `"1000"` for $0.001 USDC). */
  amount: string;
  /** Onboard request id — `onboard` kind only. */
  requestId?: string;
  /** SHA-256 hash-ref of the onboard token minted for this payment — `onboard` only. */
  onboardTokenRef?: string;
  /** Target transparency log id — `statement`/`grant` kinds. */
  logId?: string;
  /** SHA-256 content hash of the registered statement — `statement` kind. */
  contentHash?: string;
  /**
   * Dedup key. Onboard: `onboard:{requestId}:{authNonce}`.
   * Statement (legacy): `{authId}:{contentHash}:{logId}`.
   */
  idempotencyKey: string;
  /** Job creation time (Unix ms). */
  createdAt: number;
  /** Full x402 payment payload required for on-chain settlement. */
  payload: PaymentPayload;
}

/** Authorization health tracked by the settlement worker. */
export type AuthState = "active" | "suspect" | "blocked";

/** Outcome of a settlement attempt (retry vs permanent failure). */
export interface SettlementResult {
  /** True when funds were transferred on-chain. */
  ok: boolean;
  /** Transaction hash when `ok` is true. */
  txHash?: string;
  /** Error message when `ok` is false. */
  error?: string;
  /** When true, do not retry this job. */
  permanent?: boolean;
}
