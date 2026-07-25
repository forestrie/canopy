import type { SettlementJob } from "@canopy/x402-settlement-types";
import type { X402Mode } from "./x402-mode.js";

/** Cloudflare Worker bindings and secrets for the Canopy API. */
export interface Env {
  // Merklelog storage bucket (massifs + checkpoints) written by Arbor services.
  // Keys:
  // - v2/merklelog/massifs/{massifHeight}/{logId}/{massifIndex}.log
  // - v2/merklelog/checkpoints/{massifHeight}/{logId}/{massifIndex}.sth
  R2_MMRS: R2Bucket;
  // Grants storage bucket (optional legacy / other uses). Forestrie-Grant v0 path when used:
  // grant/<sha256>.cbor (content-addressed). Register-grant does not require R2 (Plan 0008).
  R2_GRANTS: R2Bucket;
  // Public base URL if clients resolve grant paths under this bucket.
  GRANT_STORAGE_PUBLIC_BASE?: string;
  // Durable Object namespace for the ingress sequencing queue.
  // Sharded by logId hash. Owned by forestrie-ingress worker.
  // Used for both enqueue (register-signed-statement) and resolveContent (query-registration-status).
  SEQUENCING_QUEUE: DurableObjectNamespace;
  CANOPY_ID: string;
  FOREST_PROJECT_ID: string;
  API_VERSION: string;
  NODE_ENV: string;
  // x402 operation mode. "verify-only" performs cryptographic verification
  // without contacting a facilitator or settling funds. "verify-and-settle"
  // (Phase 2b) will verify and charge via an x402 facilitator.
  X402_MODE?: X402Mode;
  // x402 facilitator configuration. In dev this typically points to
  // https://x402.org/facilitator on Base Sepolia; in prod it points to
  // the CDP facilitator on Base mainnet.
  X402_FACILITATOR_URL?: string;
  X402_NETWORK?: string;
  X402_PAYTO_ADDRESS?: string;
  /** Onboard-token price in atomic USDC (FOR-434; default $0.01 = "10000"). */
  X402_ONBOARD_PRICE_ATOMIC?: string;
  // Massif height for this transparency log (1-based, typically 14)
  MASSIF_HEIGHT: string;
  // Number of DO shards for the sequencing queue (typically 4)
  QUEUE_SHARD_COUNT: string;
  // Queue producer for x402 settlement jobs (Phase 2b)
  // Optional binding - only present when queue is provisioned
  X402_SETTLEMENT_QUEUE?: Queue<SettlementJob>;
  // CDP API credentials for direct x402 verification (Wrangler secrets)
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  // X402 settlement DO for auth state lookups (cross-worker binding)
  // Note: Uses untyped namespace since RPC types aren't exported across workers
  X402_SETTLEMENT_DO?: DurableObjectNamespace;
  // Number of DO shards for x402 settlement (typically 4)
  X402_DO_SHARD_COUNT?: string;
  /** Base URL of arbor Custodian (no trailing slash). */
  CUSTODIAN_URL?: string;
  /**
   * Trust-root read URL (defaults to CUSTODIAN_URL in pilot).
   * Future BYOK: Univocity trust-root service.
   */
  TRUST_ROOT_URL?: string;
  /** Maps to Custodian secret APP_TOKEN; curator/log-key + receipt verification. */
  CUSTODIAN_APP_TOKEN?: string;
  /** Delegation Coordinator base URL for BYOK public-root receipt verification. */
  DELEGATION_COORDINATOR_URL?: string;
  /** Delegation Coordinator bearer token for public-root receipt verification. */
  COORDINATOR_APP_TOKEN?: string;
  /**
   * Pool-test only: 128 hex chars = ES256 public x‖y (64 bytes) for receipt Sign1 verify
   * when Custodian is not used. Forbidden when NODE_ENV !== "test" (503).
   */
  FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX?: string;
  /** Bootstrap signing alg: ES256 (default) or KS256. */
  BOOTSTRAP_ALG?: string;
  /** Bearer secret for ops onboard-token mint/list/revoke (Wrangler secret). */
  CANOPY_OPS_ADMIN_TOKEN?: string;
  UNIVOCITY_SERVICE_URL?: string;
  /** Bearer token authorizing canopy -> univocity owned-store calls. */
  UNIVOCITY_API_TOKEN?: string;
  /** JSON map: chainId → preference-ordered RPC URLs (deploy-resolved). */
  SUPPORTED_CHAINS_RPC?: string;
  /** CREATE3 factory for uups-counterfactual genesis binding (optional). */
  CREATE3_FACTORY_ADDRESS?: string;
  ONBOARD_REQUEST_TTL_SEC?: string;
  ONBOARD_REQUEST_WEBHOOK_URL?: string;
  ONBOARD_REQUEST_WEBHOOK_SECRET?: string;
  ONBOARD_AUTO_APPROVE?: string;
  ONBOARD_AUTO_APPROVE_CHAIN_IDS?: string;
  ONBOARD_AUTO_APPROVE_LABEL_PREFIX?: string;
  ONBOARD_TOKEN_TTL_SEC?: string;
  ONBOARD_GATE_CACHE_TTL_SEC?: string;
  ONBOARD_MAX_PENDING_PER_BINDING?: string;
  ONBOARD_RPC_TIMEOUT_MS?: string;
  ONBOARD_CREATE_RATE_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
  /** Optional: base URL for checkpoint fetch (storage source when R2 not used). */
  OBJECT_STORAGE_ROOT_URL?: string;
}
