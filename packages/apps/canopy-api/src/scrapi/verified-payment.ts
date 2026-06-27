import type { PaymentPayload } from "./payment-payload.js";

/**
 * Verified payment info exposed to the worker routing layer.
 */
export interface VerifiedPayment {
  scheme: "exact";
  network: string;
  payTo: string;
  /** Payer wallet address from the authorization */
  payerAddress: `0x${string}`;
  /** Amount in atomic units */
  amount: string;
  /** The full payment payload for facilitator calls */
  payload: PaymentPayload;
}
