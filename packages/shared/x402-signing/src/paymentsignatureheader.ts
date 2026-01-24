import type { PaymentPayload } from "./paymentpayload";

export type PaymentSignatureHeader = PaymentPayload & {
  /** Hex-encoded 65-byte secp256k1 signature (r || s || recovery) */
  sig: `0x${string}`;
  /** Optional payer address; if omitted, derived from sig */
  payer?: `0x${string}`;
};
