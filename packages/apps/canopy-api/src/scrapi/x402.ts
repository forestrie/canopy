/**
 * x402 helper functions for statement registration payments.
 *
 * This module implements the standard x402 protocol using the exact scheme
 * on Base Sepolia. Payment payloads use EIP-3009 transferWithAuthorization
 * signatures that facilitators can verify and settle on-chain.
 */

// Standard x402 header names
export const X402_HEADERS = {
  /** Base64-encoded JSON payment requirements */
  paymentRequired: "X-PAYMENT-REQUIRED",
  /** Base64-encoded JSON payment payload from client */
  paymentSignature: "X-PAYMENT",
  /** Base64-encoded JSON settlement response */
  paymentResponse: "X-PAYMENT-RESPONSE",
} as const;

// Constants for Base Sepolia
const NETWORK = "eip155:84532";
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x75be7950F26fe7F15336a10b33A8D8134faDb787";

// Price in atomic units (USDC has 6 decimals)
// $0.001 = 1000 atomic units
const PRICE_ATOMIC = "1000";

// EIP-712 domain parameters for USDC on Base Sepolia
// Required for transferWithAuthorization signature verification
const USDC_EIP712_NAME = "USDC";
const USDC_EIP712_VERSION = "2";

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

/**
 * x402 v2 PaymentPayload structure.
 *
 * This is received in the X-PAYMENT header (base64-encoded) from the client.
 */
export interface PaymentPayload {
  x402Version: 1 | 2;
  scheme: "exact";
  network: string;
  payload: ExactEvmPayload;
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

export type ParsePaymentResult =
  | { ok: true; value: VerifiedPayment }
  | { ok: false; error: string };

/**
 * Build the X-PAYMENT-REQUIRED header value for POST /logs/{logId}/entries.
 *
 * Returns base64-encoded JSON per x402 v2 spec.
 */
export function buildPaymentRequiredHeader(
  resourceUrl: string,
  config?: {
    network?: string;
    payTo?: string;
    priceAtomic?: string;
  },
): string {
  const requirements: PaymentRequirements = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: config?.network ?? NETWORK,
        amount: config?.priceAtomic ?? PRICE_ATOMIC,
        asset: USDC_ADDRESS,
        payTo: config?.payTo ?? PAY_TO,
        maxTimeoutSeconds: 300,
        // EIP-712 domain parameters for USDC's transferWithAuthorization
        extra: {
          name: USDC_EIP712_NAME,
          version: USDC_EIP712_VERSION,
        },
      },
    ],
    resource: {
      url: resourceUrl,
      description: "SCRAPI statement registration",
      mimeType: "application/cose",
    },
  };

  const json = JSON.stringify(requirements);
  // Use btoa for base64 encoding (available in Workers runtime)
  return btoa(json);
}

/**
 * Parse and validate the X-PAYMENT header.
 *
 * The header contains base64-encoded JSON with the payment payload.
 * For the exact EVM scheme, this includes an EIP-3009 signature.
 */
export function parsePaymentHeader(
  raw: string | null,
  expectedConfig?: {
    network?: string;
    payTo?: string;
  },
): ParsePaymentResult {
  if (!raw || !raw.trim()) {
    return { ok: false, error: "missing X-PAYMENT header" };
  }

  // Decode base64
  let json: string;
  try {
    json = atob(raw);
  } catch {
    return { ok: false, error: "X-PAYMENT is not valid base64" };
  }

  // Parse JSON
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return { ok: false, error: "X-PAYMENT is not valid JSON" };
  }

  if (typeof payload !== "object" || payload === null) {
    return { ok: false, error: "X-PAYMENT must be a JSON object" };
  }

  const obj = payload as Record<string, unknown>;

  // Validate x402Version
  const version = obj.x402Version;
  if (version !== 1 && version !== 2) {
    return { ok: false, error: "x402Version must be 1 or 2" };
  }

  // Validate scheme
  if (obj.scheme !== "exact") {
    return { ok: false, error: 'only "exact" scheme is supported' };
  }

  // Validate network
  const expectedNetwork = expectedConfig?.network ?? NETWORK;
  if (obj.network !== expectedNetwork) {
    return {
      ok: false,
      error: `network must be ${expectedNetwork}, got ${obj.network}`,
    };
  }

  // Validate payload structure
  const innerPayload = obj.payload;
  if (typeof innerPayload !== "object" || innerPayload === null) {
    return { ok: false, error: "payload must be an object" };
  }

  const inner = innerPayload as Record<string, unknown>;

  // Validate signature
  if (typeof inner.signature !== "string" || !inner.signature) {
    return { ok: false, error: "payload.signature is required" };
  }

  // Validate authorization
  const auth = inner.authorization;
  if (typeof auth !== "object" || auth === null) {
    return { ok: false, error: "payload.authorization is required" };
  }

  const authObj = auth as Record<string, unknown>;
  const requiredAuthFields = [
    "from",
    "to",
    "value",
    "validAfter",
    "validBefore",
    "nonce",
  ];
  for (const field of requiredAuthFields) {
    if (typeof authObj[field] !== "string") {
      return { ok: false, error: `payload.authorization.${field} is required` };
    }
  }

  // Validate payTo matches expected
  const expectedPayTo = (expectedConfig?.payTo ?? PAY_TO).toLowerCase();
  const actualPayTo = (authObj.to as string).toLowerCase();
  if (actualPayTo !== expectedPayTo) {
    return {
      ok: false,
      error: `authorization.to must be ${expectedPayTo}, got ${actualPayTo}`,
    };
  }

  // Extract payer address
  const payerAddress = authObj.from as `0x${string}`;

  return {
    ok: true,
    value: {
      scheme: "exact",
      network: obj.network as string,
      payTo: authObj.to as string,
      payerAddress,
      amount: authObj.value as string,
      payload: obj as unknown as PaymentPayload,
    },
  };
}

/**
 * Get the payment requirements for the current configuration.
 *
 * Used by the facilitator client to construct verify/settle requests.
 */
export function getPaymentRequirementsForVerify(
  resourceUrl: string,
  config?: {
    network?: string;
    payTo?: string;
    priceAtomic?: string;
  },
): PaymentRequirementsOption {
  return {
    scheme: "exact",
    network: config?.network ?? NETWORK,
    amount: config?.priceAtomic ?? PRICE_ATOMIC,
    asset: USDC_ADDRESS,
    payTo: config?.payTo ?? PAY_TO,
    maxTimeoutSeconds: 300,
    extra: {
      name: USDC_EIP712_NAME,
      version: USDC_EIP712_VERSION,
    },
  };
}
