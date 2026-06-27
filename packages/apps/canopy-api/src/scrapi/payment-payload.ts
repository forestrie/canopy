import type { PaymentRequirementsOption } from "./payment-requirements.js";
import type { ResourceInfo } from "./resource-info.js";

/**
 * x402 v2 PaymentPayload structure.
 *
 * This is received in the X-PAYMENT header (base64-encoded) from the client.
 * The v2 structure includes resource info and accepted requirements.
 */
export interface PaymentPayload {
  x402Version: 1 | 2;
  /** The scheme-specific payload (authorization + signature for exact EVM) */
  payload: ExactEvmPayload;
  /** Resource being paid for */
  resource: ResourceInfo;
  /** The accepted payment requirements */
  accepted: PaymentRequirementsOption;
  /** Protocol extensions (optional) */
  extensions?: Record<string, unknown>;
  // Legacy v1 fields (for backwards compatibility)
  scheme?: "exact";
  network?: string;
}

export interface ExactEvmPayload {
  signature: string;
  authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  };
}
