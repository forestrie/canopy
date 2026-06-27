import type { OnboardTokenRecord } from "./onboard-token-record.js";

export type ClaimForestRResult =
  | { ok: true; record: OnboardTokenRecord }
  | { ok: false; reason: "not_found" | "conflict" | "cas_failed" };
