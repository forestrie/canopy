import { hasContractCodeAt, normalizeHexAddress } from "../rpc/eth-rpc.js";

export interface UnivocityGateEnv {
  UNIVOCITY_CONTRACT_RPC_URL?: string;
  ONBOARD_ALLOWED_CHAIN_ID?: string;
}

export type UnivocityGateResult =
  | { ok: true; univocityAddr: string }
  | { ok: false; status: number; detail: string };

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

  const rpcUrl = env.UNIVOCITY_CONTRACT_RPC_URL?.trim();
  if (!rpcUrl) {
    return {
      ok: false,
      status: 503,
      detail: "UNIVOCITY_CONTRACT_RPC_URL not configured",
    };
  }

  try {
    const deployed = await hasContractCodeAt(rpcUrl, addr);
    if (!deployed) {
      return {
        ok: false,
        status: 422,
        detail: "No contract code at univocityAddr on chain",
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

  return { ok: true, univocityAddr: addr };
}
