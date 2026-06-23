import type { Env } from "../../env.js";
import type { WalletChallengeNonceDO } from "../../durableobjects/wallet-challenge-nonce-do.js";

const NONCE_DO_NAME = "wallet-challenge-nonce";

export function getNonceStoreStub(env: Env) {
  const id = env.WALLET_CHALLENGE_NONCE.idFromName(NONCE_DO_NAME);
  return env.WALLET_CHALLENGE_NONCE.get(id);
}

export interface IssueNonceInput {
  authLogIdHex32: string;
  scopes: string[];
  expiresAt: number;
}

export interface IssueNonceResult {
  nonce: string;
}

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

export interface ConsumeNonceInput {
  nonce: string;
  authLogIdHex32: string;
  scopes: string[];
}

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
