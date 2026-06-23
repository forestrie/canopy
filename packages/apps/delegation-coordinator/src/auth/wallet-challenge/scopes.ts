import type { ControlPlaneScope } from "../../types/control-plane-scope.js";

const SCOPE_ENDPOINTS: Record<ControlPlaneScope, string> = {
  "delegations:read": "GET /api/delegations/pending",
  "logs:enabled:read": "GET /api/logs/{logId}/enabled",
  "logs:enabled:write": "PUT /api/logs/{logId}/enabled",
  "logs:signing-route:read": "GET /api/logs/{logId}/signing-route",
  "logs:signing-route:write": "POST /api/logs/{logId}/signing-route",
  "onboard:bind": "genesis proof-of-possession",
};

export function scopeAllows(
  granted: readonly ControlPlaneScope[],
  required: ControlPlaneScope,
): boolean {
  return granted.includes(required);
}

export function scopeEndpointHint(scope: ControlPlaneScope): string {
  return SCOPE_ENDPOINTS[scope];
}
