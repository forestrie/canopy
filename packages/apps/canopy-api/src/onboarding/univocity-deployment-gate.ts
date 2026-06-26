import { normalizeHexAddress } from "../rpc/eth-rpc.js";
import {
  readPositiveGateCache,
  writePositiveGateCache,
  type OnboardGateCacheEnv,
} from "./onboard-gate-cache.js";
import { probeUnivocityIdentity } from "./univocity-identity-probe.js";

export interface UnivocityGateEnv extends OnboardGateCacheEnv {
  UNIVOCITY_CONTRACT_RPC_URL?: string;
  ONBOARD_ALLOWED_CHAIN_ID?: string;
  ONBOARD_RPC_TIMEOUT_MS?: string;
}

export type UnivocityGateResult =
  | { ok: true; univocityAddr: string }
  | { ok: false; status: number; detail: string };

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
  const allowed = env.ONBOARD_ALLOWED_CHAIN_ID?.trim();
  if (allowed && chainId.trim() !== allowed) {
    return {
      ok: false,
      status: 400,
      detail: `chainId must be ${allowed}`,
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

  if (await readPositiveGateCache(env, chainId.trim(), addr)) {
    return { ok: true, univocityAddr: addr };
  }

  const rpcUrl = env.UNIVOCITY_CONTRACT_RPC_URL?.trim();
  if (!rpcUrl) {
    return {
      ok: false,
      status: 503,
      detail: "UNIVOCITY_CONTRACT_RPC_URL not configured",
    };
  }

  const timeout = rpcTimeoutMs(env);
  try {
    const probe = await probeUnivocityIdentity(rpcUrl, addr, timeout);
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

  await writePositiveGateCache(env, chainId.trim(), addr);
  return { ok: true, univocityAddr: addr };
}
