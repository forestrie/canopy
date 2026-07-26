import type { Env } from "../../src/index.js";
import { mintOnboardToken } from "../../src/payments/onboard-token-store.js";

/** Matches the `validGenesisV2*CborMap` fixture binding (0x42 × 20, 84532). */
export const TEST_ONBOARD_CHAIN_BINDING = {
  chainId: "84532",
  univocityAddr: "42".repeat(20),
};

/** Mint a one-off onboard token in pool R2 for genesis POST tests. */
export async function mintTestOnboardToken(
  env: Env,
  label = "vitest",
  chainBinding = TEST_ONBOARD_CHAIN_BINDING,
): Promise<{ token: string; hash: string }> {
  const minted = await mintOnboardToken(env, { label, chainBinding });
  return { token: minted.token, hash: minted.record.hash };
}
