import type { X402SettlementDO } from "./durableobjects/x402settlement.js";
import type { ReceivablesDO } from "./durableobjects/receivables.js";

/**
 * Environment bindings for the x402-settlement worker.
 */
export interface Env {
  /** Durable Object namespace for settlement processing */
  X402_SETTLEMENT_DO: DurableObjectNamespace<X402SettlementDO>;
  /** Pipe-fee receivables, one instance per liable account (ADR-0058). */
  RECEIVABLES_DO: DurableObjectNamespace<ReceivablesDO>;
  /** Canopy instance identifier */
  CANOPY_ID: string;
  /** Environment: dev or prod */
  NODE_ENV: string;
  /** Number of DO shards (typically 4) */
  DO_SHARD_COUNT: string;
  /** Upstream CDP x402 API URL (e.g. https://api.cdp.coinbase.com/platform/v2/x402) */
  X402_FACILITATOR_URL: string;
  /** Network identifier (e.g. eip155:84532) */
  X402_NETWORK: string;
  /** Settlement timeout in milliseconds */
  SETTLE_TIMEOUT_MS: string;
  /** CDP API key ID (Wrangler secret) */
  CDP_API_KEY_ID?: string;
  /** CDP API key secret - PEM-encoded EC private key (Wrangler secret) */
  CDP_API_KEY_SECRET?: string;
  /** Reservation registry, read-only by convention (writer: canopy-api). */
  R2_GRANTS?: R2Bucket;
  /** Per-chain RPC URL lists, JSON (see @forestrie/chain-rpc). */
  SUPPORTED_CHAINS_RPC?: string;
  /** Ops bearer for /admin/** (Wrangler secret; same identity as canopy-api). */
  CANOPY_OPS_ADMIN_TOKEN?: string;
  /** Slice-04 arming flag; slice 03 is observe-only and never flips the switch. */
  ENFORCEMENT_ARMED?: string;
  /**
   * canopy-api origin for the kill-switch proxy (slice 04 arming path);
   * injected per lane from CANOPY_FQDN at deploy. Required only once
   * ENFORCEMENT_ARMED is true — the indexer fails loudly if armed without it.
   */
  CANOPY_API_ORIGIN?: string;
  /**
   * Credits granted to a first-seen registered account (slice 04; FOR-438
   * decides the real amount — may stay 0). Applied idempotently at indexer
   * first sight, the moment metering starts.
   */
  STARTER_CREDITS?: string;
  /** Indexer tuning (defaults in run-indexer.ts). */
  INDEXER_CONFIRMATIONS?: string;
  INDEXER_MAX_BLOCK_RANGE?: string;
  INDEXER_MAX_RANGES_PER_RUN?: string;
  /**
   * Optional explicit backfill start for first-seen accounts: a JSON map of
   * `{"chainId": blockNumber}` (e.g. `{"84532": 12345}`). Accounts on chains
   * absent from the map observe-forward from the scan bound. One-shot ops
   * action — set, let first sight consume it, unset (plan-2607-03 R5).
   */
  INDEXER_BACKFILL_FROM_BLOCK?: string;
}
