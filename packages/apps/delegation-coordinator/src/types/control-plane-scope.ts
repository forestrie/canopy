/** Control-plane session scopes (wcc-1). */
export type ControlPlaneScope =
  | "delegations:read"
  | "logs:enabled:read"
  | "logs:enabled:write"
  | "logs:signing-route:read"
  | "logs:signing-route:write"
  | "onboard:bind";

export const CONTROL_PLANE_SCOPE_VALUES: readonly ControlPlaneScope[] = [
  "delegations:read",
  "logs:enabled:read",
  "logs:enabled:write",
  "logs:signing-route:read",
  "logs:signing-route:write",
  "onboard:bind",
] as const;

export const WALLET_CHALLENGE_VERSION = "wcc-1" as const;

export function isControlPlaneScope(value: string): value is ControlPlaneScope {
  return (CONTROL_PLANE_SCOPE_VALUES as readonly string[]).includes(value);
}
