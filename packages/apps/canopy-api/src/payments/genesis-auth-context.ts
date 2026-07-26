import type { OnboardTokenRecord } from "./onboard-token-record.js";

/** Onboard bearer is the only genesis authorization (ADR-0059, slice 02). */
export type GenesisAuthContext = {
  mode: "onboard";
  tokenHash: string;
  tokenRecord: OnboardTokenRecord;
};
