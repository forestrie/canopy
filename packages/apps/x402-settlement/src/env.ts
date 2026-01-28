import type { X402SettlementDO } from "./durableobjects/x402settlement.js";

/**
 * Environment bindings for the x402-settlement worker.
 */
export interface Env {
  /** Durable Object namespace for settlement processing */
  X402_SETTLEMENT_DO: DurableObjectNamespace<X402SettlementDO>;
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
}
