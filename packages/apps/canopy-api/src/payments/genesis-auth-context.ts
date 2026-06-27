import type { OnboardTokenRecord } from "./onboard-token-record.js";
import type { GrantResult } from "../grant/types.js";

export type GenesisAuthContext =
  | { mode: "onboard"; tokenHash: string; tokenRecord: OnboardTokenRecord }
  | { mode: "endorsement"; endorserUuid: string; grantResult: GrantResult };
