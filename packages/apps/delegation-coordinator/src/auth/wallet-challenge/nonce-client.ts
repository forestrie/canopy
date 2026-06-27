/**
 * Client for {@link WalletChallengeNonceDO} issue/consume RPCs.
 *
 * Upstream: POST /api/auth/challenge and /session handlers.
 * Downstream: global nonce Durable Object (single instance per worker).
 */

import type { Env } from "../../env.js";
import type { WalletChallengeNonceDO } from "../../durableobjects/wallet-challenge-nonce-do.js";

/** Stable DO name for the global nonce store. */
const NONCE_DO_NAME = "wallet-challenge-nonce";

/**
 * Resolve stub for the global wallet-challenge nonce Durable Object.
 *
 * @param env - Worker bindings.
 */
export function getNonceStoreStub(env: Env) {
  const id = env.WALLET_CHALLENGE_NONCE.idFromName(NONCE_DO_NAME);
  return env.WALLET_CHALLENGE_NONCE.get(id);
}

/** Inputs for issuing a one-time challenge nonce. */
export interface IssueNonceInput {
  authLogIdHex32: string;
  scopes: string[];
  expiresAt: number;
}

/** Nonce string returned from issue RPC. */
export interface IssueNonceResult {
  nonce: string;
}

/**
 * Issue a fresh challenge nonce bound to auth log and scopes.
 *
 * @param env - Worker bindings.
 * @param input - authLogId, scopes, envelope expiry (ms).
 * @returns New nonce id for the challenge response.
 */
export async function issueWalletChallengeNonce(
  env: Env,
  input: IssueNonceInput,
): Promise<IssueNonceResult> {
  const stub = getNonceStoreStub(env);
  const resp = await stub.fetch("https://nonce.internal/issue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!resp.ok) {
    throw new Error(`nonce issue failed: ${resp.status}`);
  }
  return (await resp.json()) as IssueNonceResult;
}

/** Inputs for single-use nonce consumption at session exchange. */
export interface ConsumeNonceInput {
  nonce: string;
  authLogIdHex32: string;
  scopes: string[];
}

/**
 * Consume a challenge nonce if valid and unconsumed.
 *
 * @param env - Worker bindings.
 * @param input - nonce, authLogId, and requested scopes.
 * @returns false on 409 (unknown/consumed/mismatch), true on success.
 */
export async function consumeWalletChallengeNonce(
  env: Env,
  input: ConsumeNonceInput,
): Promise<boolean> {
  const stub = getNonceStoreStub(env);
  const resp = await stub.fetch("https://nonce.internal/consume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (resp.status === 409) return false;
  if (!resp.ok) {
    throw new Error(`nonce consume failed: ${resp.status}`);
  }
  return true;
}

export type { WalletChallengeNonceDO };
