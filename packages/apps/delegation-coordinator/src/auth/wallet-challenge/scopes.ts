/**
 * Control-plane scope checks for wallet-challenge session tokens.
 *
 * Maps granted scopes to /api/ route capabilities defined in wcc-1.
 */

import type { ControlPlaneScope } from "../../types/control-plane-scope.js";

/** Human-readable endpoint hint per scope (documentation / errors). */
const SCOPE_ENDPOINTS: Record<ControlPlaneScope, string> = {
  "delegations:read": "GET /api/delegations/pending",
  "logs:enabled:read": "GET /api/logs/{logId}/enabled",
  "logs:enabled:write": "PUT /api/logs/{logId}/enabled",
  "logs:signing-route:read": "GET /api/logs/{logId}/signing-route",
  "logs:signing-route:write": "POST /api/logs/{logId}/signing-route",
  "onboard:bind": "genesis proof-of-possession",
};

/**
 * True when the session's granted scopes include the required capability.
 *
 * @param granted - Scopes from verified session token.
 * @param required - Scope required by the route handler.
 */
export function scopeAllows(
  granted: readonly ControlPlaneScope[],
  required: ControlPlaneScope,
): boolean {
  return granted.includes(required);
}

/**
 * Return a short endpoint hint for a scope (error messages / docs).
 *
 * @param scope - Control-plane scope.
 */
export function scopeEndpointHint(scope: ControlPlaneScope): string {
  return SCOPE_ENDPOINTS[scope];
}
