import type { ControlPlaneScope } from "./control-plane-scope.js";

export interface ChallengeRequest {
  authLogId: string;
  scopes: ControlPlaneScope[];
}

export interface ChallengeResponse {
  version: "wcc-1";
  nonce: string;
  authLogId: string;
  scopes: ControlPlaneScope[];
  issuedAt: number;
  expiresAt: number;
  domain: string;
  coordinatorOrigin: string;
}

export interface WalletChallengeEnvelope {
  version: "wcc-1";
  domain: string;
  coordinatorOrigin: string;
  authLogId: string;
  scopes: ControlPlaneScope[];
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  chainId?: string;
}

export interface SessionExchangeRequest {
  envelope: WalletChallengeEnvelope;
  signature: string;
  alg: "KS256" | "ES256";
}

export interface SessionExchangeResponse {
  token: string;
  expiresAt: number;
  authLogId: string;
  scopes: ControlPlaneScope[];
}

export interface SessionTokenClaims {
  v: 1;
  authLogId: string;
  scopes: ControlPlaneScope[];
  exp: number;
  aud: string;
}
