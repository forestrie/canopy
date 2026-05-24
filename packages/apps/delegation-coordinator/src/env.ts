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
}
