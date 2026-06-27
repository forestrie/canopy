/**
 * Signing route mode and per-log configuration.
 *
 * Stored in {@link DelegationStoreDO}; `issuerToken` enables dual-token auth
 * on POST /api/delegations per
 * [ARC-0017](https://github.com/forestrie/devdocs/blob/main/arc/arc-0017-hierarchical-authority-logs-and-fee-distribution.md).
 */

/** How delegation signing is routed for a log. */
export type SigningRouteMode = "wallet" | "http";

/** Per-log signing route configuration stored in DelegationStoreDO. */
export interface SigningRoute {
  mode: SigningRouteMode;
  inheritsFrom?: string;
  issuerToken?: string;
}
