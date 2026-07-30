import { normalizeHexAddress } from "@forestrie/chain-rpc";
import {
  erc1271HooksForEnvChainId,
  isSupportedChainIdForEnv,
  rpcUrlsForEnvChainId,
  supportedChainIdsForEnv,
} from "../env/supported-chains-for-env.js";
import type { BootstrapKeyVerifyCapabilities } from "./onboard-attestation.js";
import { COSE_ALG_KS256 } from "./univocity-identity-probe.js";
import {
  readPositiveGateCache,
  writePositiveGateCache,
} from "./onboard-gate-cache.js";
import { probeUnivocityIdentity } from "./univocity-identity-probe.js";
import type { UnivocityGateEnv } from "./univocity-gate-env.js";
import type { UnivocityGateResult } from "./univocity-gate-result.js";

export type { UnivocityGateEnv, UnivocityGateResult } from "./types.js";

export function rpcTimeoutMs(env: UnivocityGateEnv): number {
  const raw = env.ONBOARD_RPC_TIMEOUT_MS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 5000;
}

/**
 * Verify capabilities for a gate-admitted `(alg, key)`: the ERC-1271 hook
 * when RPC is configured for the binding chain. A KS256 root admitted via a
 * warm gate cache can outlive a `SUPPORTED_CHAINS_RPC` change — warn loudly
 * in that case, because a contract-account root will then 403 with a generic
 * invalid-signature detail while EOA roots keep passing (plan-2607-09 C3).
 */
export function attestationVerifyCapabilities(
  env: UnivocityGateEnv,
  chainId: string,
  bootstrapAlg: number,
): BootstrapKeyVerifyCapabilities {
  const erc1271 = erc1271HooksForEnvChainId(env, chainId, {
    timeoutMs: rpcTimeoutMs(env),
  });
  if (!erc1271 && bootstrapAlg === COSE_ALG_KS256) {
    console.warn(
      JSON.stringify({
        tag: "erc1271HooksMissing",
        chainId,
        detail:
          "no RPC configured for chain; a contract-account KS256 root cannot verify (EOA recovery only)",
      }),
    );
  }
  return { erc1271 };
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

  const cached = await readPositiveGateCache(env, trimmedChainId, addr);
  if (cached) {
    return {
      ok: true,
      univocityAddr: addr,
      bootstrapAlg: cached.alg,
      bootstrapKey: cached.key,
    };
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
  let identity: { alg: number; key: Uint8Array };
  try {
    const probe = await probeUnivocityIdentity(rpcUrls, addr, timeout);
    if (!probe.ok) {
      return {
        ok: false,
        // RPC unavailability is 503, never a verdict; decode-level
        // rejections stay 422 (plan-2607-46 slice 01).
        status: probe.unavailable ? 503 : 422,
        detail: probe.detail,
      };
    }
    identity = { alg: probe.alg, key: probe.key };
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

  await writePositiveGateCache(env, trimmedChainId, addr, identity);
  return {
    ok: true,
    univocityAddr: addr,
    bootstrapAlg: identity.alg,
    bootstrapKey: identity.key,
  };
}
