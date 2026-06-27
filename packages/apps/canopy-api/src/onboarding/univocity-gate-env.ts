import type { SupportedChainsEnv } from "../env/supported-chains-for-env.js";
import type { OnboardGateCacheEnv } from "./onboard-gate-cache.js";

export interface UnivocityGateEnv
  extends OnboardGateCacheEnv,
    SupportedChainsEnv {
  ONBOARD_RPC_TIMEOUT_MS?: string;
}
