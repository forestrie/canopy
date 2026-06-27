import type { OnboardRequestRecord } from "./onboard-request-record.js";

export type RedeemCasResult =
  | { ok: true; record: OnboardRequestRecord }
  | { ok: false; reason: "not_found" | "wrong_state" | "cas_failed" };
