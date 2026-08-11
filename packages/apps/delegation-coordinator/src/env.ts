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
   * Base64 `x||y` (64 bytes) of the custodian's registrar voucher public key
   * (FOR-390 phase H). Delegate-key registration verifies each key's voucher
   * against this before advertising it, so a compromised COORDINATOR_APP_TOKEN
   * cannot introduce an attacker-controlled delegate key. Empty disables
   * delegate-key registration (fails closed). Set via
   * `wrangler secret put PINNED_REGISTRAR_KEY`.
   */
  PINNED_REGISTRAR_KEY?: string;
  /**
   * When "true", the issue path only records a pending demand + fires a signer
   * webhook for a *registered* standing delegate key (FOR-390 phase H2
   * membership). Closes the arbitrary-key injection: a compromised
   * COORDINATOR_APP_TOKEN can no longer make a root holder delegate to an
   * attacker key. Gated (default off) so epoch-0 on-demand ephemeral sealers
   * are unaffected until enablement; turned on with DELEGATE_KEY_EPOCH>=1.
   */
  ENFORCE_DELEGATE_KEY_MEMBERSHIP?: string;
  /**
   * Dev only: set via Doppler ref
   * `${forest-platform.dev.COORDINATOR_RESET_TOKEN}` (synced by deploy-workers
   * on dev lane).
   */
  COORDINATOR_RESET_TOKEN?: string;
  /**
   * Opt-in for /admin/reset-storage on non-dev workers ("1" to allow). Set as
   * a wrangler secret on prod-lane workers of DEV forests only (content-reset
   * needs to wipe both lanes); never set on true production forests. The
   * endpoint remains token-gated by COORDINATOR_RESET_TOKEN either way.
   */
  COORDINATOR_RESET_ALLOWED?: string;
  /**
   * ADR-0010 per-chain RPC config: JSON `{chainId: [urls]}`. ERC-1271
   * verification selects endpoints by the log's chain binding (plan-2607-46
   * slice 03) and asserts `eth_chainId` on first use.
   */
  SUPPORTED_CHAINS_RPC?: string;
  /**
   * @deprecated Single-URL fallback for {@link SUPPORTED_CHAINS_RPC}; still
   * chain-asserted per log. Remove once SUPPORTED_CHAINS_RPC is configured
   * everywhere (plan-2607-46 enact-time check).
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
  /**
   * Cloudflare Queues API base for the sealer's trigger queue (same shape as
   * the sealer's QUEUE_URL / ranger's SEAL_HINT_QUEUE_URL). When set, a
   * certificate that satisfies parked pending-delegation rows publishes a
   * seal hint so the deferring sealer retries immediately instead of on its
   * redelivery/resync cadence (see src/seal-hint.ts). Empty disables.
   */
  SEAL_HINT_QUEUE_URL?: string;
  /** Bearer for the queue push API. Set via `wrangler secret put`. */
  SEAL_HINT_QUEUE_TOKEN?: string;
  /** Massif heights to hint, comma-separated (default "14"). */
  SEAL_HINT_MASSIF_HEIGHTS?: string;
}
