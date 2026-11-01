/**
 * Read a job's EIP-3009 authorization state from the token contract
 * (FOR-616).
 *
 * The facilitator's reply is not proof either way. The x402 reference
 * facilitator wraps both its `writeContract` and its receipt wait in one
 * `catch` that returns `transaction_failed`, so it can report a failure for a
 * transaction that is broadcast and later mines. A retry of that job then
 * fails again (the nonce is spent) and would be booked as unpaid although
 * the money moved. The token contract is the authority: once
 * `authorizationState(from, nonce)` is true, the authorization has been used.
 *
 * Caveat: the contract records the (payer, nonce) pair, not which signed
 * authorization used it. A payer who signs a second authorization with the
 * same nonce to someone else and settles that first would read as paid here.
 * Canopy could not collect in that case anyway, since the nonce is spent; the
 * cost is a credit the instance pool did not earn. Confirming the matching
 * Transfer in the settling transaction would close it.
 */
import type { SettlementJob } from "@canopy/x402-settlement-types";
import {
  ethCallWithFailover,
  parseSupportedChainsRpc,
  rpcUrlsForChainId,
} from "@forestrie/chain-rpc";
import type { Env } from "./env.js";

/** `authorizationState(address,bytes32)` selector (USDC FiatTokenV2). */
const AUTHORIZATION_STATE_SELECTOR = "e94a0102";
const RPC_TIMEOUT_MS = 5_000;

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * True when the token contract has spent the job's authorization nonce,
 * false when it has not, undefined when it cannot tell (no RPC configured
 * for the chain, malformed fields, or every endpoint failed).
 */
export async function authorizationSpent(
  env: Env,
  job: SettlementJob,
): Promise<boolean | undefined> {
  const accepted = job.payload?.accepted;
  const auth = job.payload?.payload?.authorization;
  const chainId = accepted?.network?.match(/^eip155:(\d+)$/)?.[1];
  if (
    !chainId ||
    !HEX_ADDRESS.test(accepted?.asset ?? "") ||
    !HEX_ADDRESS.test(auth?.from ?? "") ||
    !HEX_BYTES32.test(auth?.nonce ?? "")
  ) {
    return undefined;
  }
  const raw = env.SUPPORTED_CHAINS_RPC?.trim();
  if (!raw) return undefined;
  try {
    const urls = rpcUrlsForChainId(parseSupportedChainsRpc(raw), chainId);
    if (!urls) return undefined;
    const data =
      `0x${AUTHORIZATION_STATE_SELECTOR}` +
      auth!.from.slice(2).toLowerCase().padStart(64, "0") +
      auth!.nonce.slice(2).toLowerCase();
    const result = await ethCallWithFailover(urls, accepted!.asset, data, {
      timeoutMs: RPC_TIMEOUT_MS,
    });
    if (typeof result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result)) {
      return undefined;
    }
    return BigInt(result === "0x" ? 0 : result) !== 0n;
  } catch (err) {
    console.warn("authorizationState read failed", {
      jobId: job.jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
