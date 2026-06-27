import type { OnboardRequestRecord } from "./onboard-request-record.js";
import { isSupportedChainIdForEnv } from "../env/supported-chains-for-env.js";

export interface OnboardAutoApproveEnv {
  NODE_ENV?: string;
  ONBOARD_AUTO_APPROVE?: string;
  ONBOARD_AUTO_APPROVE_CHAIN_IDS?: string;
  ONBOARD_AUTO_APPROVE_LABEL_PREFIX?: string;
  SUPPORTED_CHAINS_RPC?: string;
}

export function shouldAutoApproveRequest(
  env: OnboardAutoApproveEnv,
  record: OnboardRequestRecord,
): boolean {
  if (env.NODE_ENV?.trim() === "prod") {
    return false;
  }

  const enabled = env.ONBOARD_AUTO_APPROVE?.trim().toLowerCase();
  if (enabled !== "true" && enabled !== "1") {
    return false;
  }

  const allowlist = env.ONBOARD_AUTO_APPROVE_CHAIN_IDS?.trim();
  if (allowlist) {
    const ids = allowlist.split(",").map((s) => s.trim());
    if (!ids.includes(record.chainBinding.chainId)) {
      return false;
    }
    for (const id of ids) {
      if (!isSupportedChainIdForEnv(env, id)) {
        return false;
      }
    }
  }

  const prefix = env.ONBOARD_AUTO_APPROVE_LABEL_PREFIX?.trim();
  if (prefix && !record.label.startsWith(prefix)) {
    return false;
  }

  return true;
}
