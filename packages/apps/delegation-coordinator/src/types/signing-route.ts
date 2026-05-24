export type SigningRouteMode = "wallet" | "http";

/** Per-log signing route configuration stored in DelegationStoreDO. */
export interface SigningRoute {
  mode: SigningRouteMode;
  inheritsFrom?: string;
  issuerToken?: string;
}
