/**
 * Wallet-challenge control-plane scopes (wcc-1).
 *
 * Scopes gate user-facing /api/ routes after session exchange. Operator
 * /admin/api/ routes use {@link Env.COORDINATOR_APP_TOKEN} instead. See
 * [ARC-0017 hierarchy](https://github.com/forestrie/devdocs/blob/main/arc/arc-0017-hierarchical-authority-logs-and-fee-distribution.md).
 */

/** Named capability granted by a wallet-challenge session token. */
export type ControlPlaneScope =
  | "delegations:read"
  | "logs:enabled:read"
  | "logs:enabled:write"
  | "logs:signing-route:read"
  | "logs:signing-route:write"
  | "onboard:bind";

/** All valid scope strings for validation at challenge issuance. */
export const CONTROL_PLANE_SCOPE_VALUES: readonly ControlPlaneScope[] = [
  "delegations:read",
  "logs:enabled:read",
  "logs:enabled:write",
  "logs:signing-route:read",
  "logs:signing-route:write",
  "onboard:bind",
] as const;

/** Wallet-challenge envelope and session token version identifier. */
export const WALLET_CHALLENGE_VERSION = "wcc-1" as const;

/**
 * Type guard for scope strings parsed from challenge requests.
 *
 * @param value - Raw scope string from JSON.
 * @returns True when value is a known {@link ControlPlaneScope}.
 */
export function isControlPlaneScope(value: string): value is ControlPlaneScope {
  return (CONTROL_PLANE_SCOPE_VALUES as readonly string[]).includes(value);
}
