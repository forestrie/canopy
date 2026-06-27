import type { VerifiedPayment } from "./verified-payment.js";

export type ParsePaymentResult =
  | { ok: true; value: VerifiedPayment }
  | { ok: false; error: string };
