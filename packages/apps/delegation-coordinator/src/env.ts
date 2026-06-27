/**
 * Worker environment bindings for delegation-coordinator.
 *
 * Upstream: Wrangler/Doppler deploy, Secrets Store, sibling
 * [arbor custodian](https://github.com/forestrie/arbor/blob/main/services/custodian/)
 * and optional KS256 JSON-RPC for ERC-1271 verify per
 * [univocity docs/arc](https://github.com/forestrie/univocity/blob/main/docs/arc/).
 * Downstream: HTTP handlers and {@link DelegationStoreDO} shards.
 */

import type { DelegationStoreDO } from "./durableobjects/delegation-store.js";
import type { WalletChallengeNonceDO } from "./durableobjects/wallet-challenge-nonce-do.js";

/** Cloudflare Worker bindings and secrets for delegation-coordinator. */
export interface Env {
  /** Durable Object namespace for per-shard delegation persistence. */
  DELEGATION_STORE: DurableObjectNamespace<DelegationStoreDO>;
  /** Global Durable Object for wallet-challenge nonce issuance. */
  WALLET_CHALLENGE_NONCE: DurableObjectNamespace<WalletChallengeNonceDO>;
  /** Base URL for Custodian create-only key orchestration. */
  CUSTODIAN_URL: string;
  /** Deployment lane: `dev` or `prod`. */
  NODE_ENV: string;
  /** Number of {@link DelegationStoreDO} shards (typically 4). */
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
   * Dev only: set via Doppler ref
   * `${forest-platform.dev.COORDINATOR_RESET_TOKEN}` (synced by deploy-workers
   * on dev lane).
   */
  COORDINATOR_RESET_TOKEN?: string;
  /**
   * Optional JSON-RPC URL for KS256 ERC-1271 delegation certificate verify.
   */
  KS256_RPC_URL?: string;
  /**
   * Cloudflare Secrets Store binding for the coordinator webhook ES256
   * identity private key (PKCS#8 PEM). Preferred in deployed environments.
   */
  WEBHOOK_SIGNING_KEY?: SecretsStoreSecret;
  /**
   * PKCS#8 PEM fallback for local dev and vitest (when Secrets Store unset).
   */
  WEBHOOK_SIGNING_KEY_PEM?: string;
  /** Public coordinator base URL for certificateSubmitUrl in webhook events. */
  COORDINATOR_PUBLIC_URL?: string;
  /** JSON array of retry multipliers, e.g. `[1,2,4,8]`. */
  WEBHOOK_RETRY_LADDER?: string;
  /** Retry scale in ms (default 1000). */
  WEBHOOK_RETRY_SCALE_MS?: string;
  /** HMAC secret for control-plane session tokens. */
  WALLET_CHALLENGE_SIGNING_SECRET?: string;
  /** SIWE-style domain string for challenge envelopes. */
  COORDINATOR_DOMAIN?: string;
  /** When `true`, enable POST /api/auth/challenge and /session. */
  ENABLE_WALLET_CHALLENGE?: string;
  /** When `true`, UX routes reject COORDINATOR_APP_TOKEN. */
  REQUIRE_WALLET_SESSION_FOR_UX?: string;
}
