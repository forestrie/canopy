import type { DelegationStoreDO } from "./durableobjects/delegation-store.js";

/**
 * Environment bindings for the delegation-coordinator worker.
 */
export interface Env {
  /** Durable Object namespace for delegation store shards */
  DELEGATION_STORE: DurableObjectNamespace<DelegationStoreDO>;
  /** Base URL for Custodian (create-only key orchestration) */
  CUSTODIAN_URL: string;
  /** Environment: dev or prod */
  NODE_ENV: string;
  /** Number of DO shards (typically 4) */
  COORDINATOR_SHARD_COUNT: string;
  /**
   * Bearer token for coordinator management APIs.
   * Set via `wrangler secret put COORDINATOR_APP_TOKEN`.
   */
  COORDINATOR_APP_TOKEN?: string;
  /**
   * Bearer token for Custodian POST /api/keys (create-only proxy).
   * Set via `wrangler secret put CUSTODIAN_APP_TOKEN`.
   */
  CUSTODIAN_APP_TOKEN?: string;
  /**
   * Dev only: set via Doppler ref `${forest-platform.dev.COORDINATOR_RESET_TOKEN}`
   * (synced to Worker by deploy-workers on dev lane).
   */
  COORDINATOR_RESET_TOKEN?: string;
  /** Optional JSON-RPC URL for KS256 ERC-1271 delegation material verify. */
  KS256_RPC_URL?: string;
  /**
   * Cloudflare Secrets Store binding for the coordinator webhook ES256 identity
   * private key (PKCS#8 PEM). Preferred in deployed environments.
   */
  WEBHOOK_SIGNING_KEY?: SecretsStoreSecret;
  /**
   * PKCS#8 PEM fallback for local dev and vitest (when Secrets Store is unset).
   */
  WEBHOOK_SIGNING_KEY_PEM?: string;
  /** Public coordinator base URL for materialSubmitUrl in webhook events. */
  COORDINATOR_PUBLIC_URL?: string;
  /** JSON array of retry multipliers, e.g. `[1,2,4,8]`. */
  WEBHOOK_RETRY_LADDER?: string;
  /** Retry scale in ms (default 1000). */
  WEBHOOK_RETRY_SCALE_MS?: string;
}
