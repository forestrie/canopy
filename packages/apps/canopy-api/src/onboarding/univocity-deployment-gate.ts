import { normalizeHexAddress } from "@canopy/chain-rpc";
import {
  isSupportedChainIdForEnv,
  rpcUrlsForEnvChainId,
  supportedChainIdsForEnv,
} from "../env/supported-chains-for-env.js";
import {
  readPositiveGateCache,
  writePositiveGateCache,
} from "./onboard-gate-cache.js";
import { probeUnivocityIdentity } from "./univocity-identity-probe.js";
import type { UnivocityGateEnv } from "./univocity-gate-env.js";
import type { UnivocityGateResult } from "./univocity-gate-result.js";

export type { UnivocityGateEnv, UnivocityGateResult } from "./types.js";

function rpcTimeoutMs(env: UnivocityGateEnv): number {
  const raw = env.ONBOARD_RPC_TIMEOUT_MS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 5000;
}

export async function verifyUnivocityDeployment(
  env: UnivocityGateEnv,
  chainId: string,
  univocityAddrRaw: string,
): Promise<UnivocityGateResult> {
  const trimmedChainId = chainId.trim();
  const supportedIds = supportedChainIdsForEnv(env);
  if (supportedIds.length === 0) {
    return {
      ok: false,
      status: 503,
      detail: "SUPPORTED_CHAINS_RPC not configured",
    };
  }
  if (!isSupportedChainIdForEnv(env, trimmedChainId)) {
    return {
      ok: false,
      status: 400,
      detail: `chainId ${trimmedChainId} is not supported (allowed: ${supportedIds.join(", ")})`,
    };
  }

  const addr = normalizeHexAddress(univocityAddrRaw);
  if (!addr) {
    return {
      ok: false,
      status: 400,
      detail: "univocityAddr must be 20-byte hex",
    };
  }

  if (await readPositiveGateCache(env, trimmedChainId, addr)) {
    return { ok: true, univocityAddr: addr };
  }

  const rpcUrls = rpcUrlsForEnvChainId(env, trimmedChainId);
  if (!rpcUrls?.length) {
    return {
      ok: false,
      status: 503,
      detail: `No RPC URLs configured for chainId ${trimmedChainId}`,
    };
  }

  const timeout = rpcTimeoutMs(env);
  try {
    const probe = await probeUnivocityIdentity(rpcUrls, addr, timeout);
    if (!probe.ok) {
      return {
        ok: false,
        status: 422,
        detail: probe.detail,
      };
    }
  } catch (error) {
    return {
      ok: false,
      status: 503,
      detail:
        error instanceof Error
          ? `RPC check failed: ${error.message}`
          : "RPC check failed",
    };
  }

  await writePositiveGateCache(env, trimmedChainId, addr);
  return { ok: true, univocityAddr: addr };
}
