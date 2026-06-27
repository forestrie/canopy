/**
 * x402 v2 PaymentRequirements structure.
 *
 * This is returned in the X-PAYMENT-REQUIRED header (base64-encoded)
 * when a 402 response is sent.
 */
export interface PaymentRequirements {
  x402Version: 2;
  accepts: PaymentRequirementsOption[];
  error?: string;
  resource?: {
    url: string;
    description?: string;
    mimeType?: string;
  };
}

export interface PaymentRequirementsOption {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}
