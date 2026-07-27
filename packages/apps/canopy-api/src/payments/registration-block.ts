/**
 * Observe the chain head at the moment a reservation completes to
 * `registered` — the account's metering floor (plan-2607-04 / FOR-477).
 *
 * One `eth_blockNumber` call, strictly best-effort: genesis is the paid
 * critical path and must never block on chain RPC, so any failure records
 * `null` (repairable via the ops chain-bindings PATCH). Head lag only errs
 * safe — a stale `latest` lowers the floor, and accrual is idempotent per
 * event, so over-scan is harmless while under-scan cannot occur (a tx sent
 * after registration can never land in an already-mined block).
 */

import { ethRpcWithFailover } from "../rpc/eth-rpc.js";
import {
  rpcUrlsForEnvChainId,
  type SupportedChainsEnv,
} from "../env/supported-chains-for-env.js";
import { isValidRegistrationBlock } from "./instance-registry.js";

const REGISTRATION_BLOCK_TIMEOUT_MS = 2000;

export async function observeRegistrationBlock(
  env: SupportedChainsEnv,
  chainId: string,
): Promise<number | null> {
  const rpcUrls = rpcUrlsForEnvChainId(env, chainId);
  if (!rpcUrls?.length) return null;
  try {
    const result = await ethRpcWithFailover(rpcUrls, "eth_blockNumber", [], {
      timeoutMs: REGISTRATION_BLOCK_TIMEOUT_MS,
    });
    if (typeof result !== "string") return null;
    const block = Number.parseInt(result, 16);
    return isValidRegistrationBlock(block) ? block : null;
  } catch (error) {
    console.warn(
      `registration-block: eth_blockNumber failed for chain ${chainId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
