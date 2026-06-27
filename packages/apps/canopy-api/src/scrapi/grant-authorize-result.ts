import type { ReceiptInclusionVerifyOutcome } from "../grant/receipt-verify.js";

export interface GrantAuthorizeFailure {
  response: Response;
  outcome: ReceiptInclusionVerifyOutcome;
  verifyKeyCount: number;
  hasDelegationCert: boolean;
}

export type GrantAuthorizeResult =
  | { ok: true }
  | ({ ok: false } & GrantAuthorizeFailure);
