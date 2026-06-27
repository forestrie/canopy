/**
 * Wallet-challenge (wcc-1) request/response and session token types.
 *
 * Upstream: POST /api/auth/challenge and /session handlers.
 * Downstream: {@link WalletChallengeNonceDO}, session HMAC in
 * auth/wallet-challenge/session-token, and {@link requireUserSessionOrResponse}.
 * Signer binding uses stored public roots (ES256 or KS256 per
 * [univocity docs/arc](https://github.com/forestrie/univocity/blob/main/docs/arc/)).
 */

import type { ControlPlaneScope } from "./control-plane-scope.js";

/** JSON body for POST /api/auth/challenge. */
export interface ChallengeRequest {
  authLogId: string;
  scopes: ControlPlaneScope[];
}

/** JSON response from POST /api/auth/challenge. */
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

/** Signed challenge envelope exchanged for a session token. */
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

/** JSON body for POST /api/auth/session. */
export interface SessionExchangeRequest {
  envelope: WalletChallengeEnvelope;
  signature: string;
  alg: "KS256" | "ES256";
  /** ES256 only: base64-encoded 32-byte P-256 public key x coordinate. */
  publicKeyX?: string;
  /** ES256 only: base64-encoded 32-byte P-256 public key y coordinate. */
  publicKeyY?: string;
}

/** JSON response from POST /api/auth/session. */
export interface SessionExchangeResponse {
  token: string;
  expiresAt: number;
  authLogId: string;
  scopes: ControlPlaneScope[];
}

/** Parsed claims from a v1 HMAC session token. */
export interface SessionTokenClaims {
  v: 1;
  authLogId: string;
  scopes: ControlPlaneScope[];
  exp: number;
  aud: string;
}
