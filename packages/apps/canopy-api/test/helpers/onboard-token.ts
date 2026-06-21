import type { Env } from "../../src/index.js";
import { mintOnboardToken } from "../../src/payments/onboard-token-store.js";

/** Mint a one-off onboard token in pool R2 for genesis POST tests. */
export async function mintTestOnboardToken(
  env: Env,
  label = "vitest",
): Promise<{ token: string; hash: string }> {
  const minted = await mintOnboardToken(env, { label });
  return { token: minted.token, hash: minted.record.hash };
}
