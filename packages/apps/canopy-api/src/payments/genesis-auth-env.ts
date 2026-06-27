import type { ReceiptAuthorityResolver } from "../env/receipt-authority-resolver.js";
import type { OnboardTokenStoreEnv } from "./onboard-token-store-env.js";
import type { RegistrationStoreEnv } from "./registration-store.js";

export interface GenesisAuthEnv
  extends OnboardTokenStoreEnv,
    RegistrationStoreEnv {
  NODE_ENV: string;
  resolveReceiptAuthority?: ReceiptAuthorityResolver;
}
