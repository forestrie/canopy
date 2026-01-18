// x402 helper functions for the yolo (no-facilitator) phase.
//
// This module centralizes header names, nominal pricing, and light-weight
// JSON validation for the Payment-Required and Payment-Signature headers
// used to protect POST /logs/{logId}/entries.

export const X402_HEADERS = {
  paymentRequired: "Payment-Required",
  paymentSignature: "Payment-Signature",
} as const;

export type X402Scheme = "exact" | "upto";

export interface X402Option {
  scheme: X402Scheme;
  network: string;
  price: string;
  payTo: string;
  minPrice?: string;
  description?: string;
}

export interface PaymentRequiredPayload {
  resource: string;
  options: X402Option[];
}

export interface PaymentSignaturePayload {
  scheme: X402Scheme;
  network: string;
  price?: string;
  maxAmount?: string;
  minPrice?: string;
  payTo: string;
  nonce: string;
  proof: string;
  expiresAt?: string;
}

const NETWORK_SEPOLIA = "eip155:84532";

// For the yolo phase we do not contact a facilitator, so this value is
// effectively informational. We still record the intended payTo target so
// later phases can wire a real address without changing headers.
// Resolved forestrie.eth: 0x75be7950F26fe7F15336a10b33A8D8134faDb787
const PAY_TO_TESTNET = "0x75be7950F26fe7F15336a10b33A8D8134faDb787";

// Nominal prices (USD) used for initial registration. These can be refined
// in later phases but are kept very small to support micropayments.
const PRICE_EXACT = "$0.001";
const PRICE_UPTO_MAX = "$1.00";

/**
 * Build the Payment-Required payload for POST /logs/{logId}/entries.
 */
export function buildPaymentRequiredForRegister(logId: string): string {
  const payload: PaymentRequiredPayload = {
    resource: "POST /logs/{logId}/entries",
    options: [
      {
        scheme: "exact",
        network: NETWORK_SEPOLIA,
        price: PRICE_EXACT,
        payTo: PAY_TO_TESTNET,
        description: "Per-statement registration",
      },
      {
        scheme: "upto",
        network: NETWORK_SEPOLIA,
        price: PRICE_UPTO_MAX,
        minPrice: PRICE_EXACT,
        payTo: PAY_TO_TESTNET,
        description: "Sign once, settle many registrations",
      },
    ],
  };

  // Single-line JSON keeps the header value simple and HTTP-safe.
  return JSON.stringify(payload);
}

export type ParsePaymentSignatureResult =
  | { ok: true; value: PaymentSignaturePayload }
  | { ok: false; error: string };

/**
 * Parse and syntactically validate the Payment-Signature header.
 *
 * Yolo semantics:
 * - Ensures the header is present and parses as JSON.
 * - Ensures `scheme` is "exact" or "upto".
 * - Ensures `network`, `payTo`, `nonce`, and `proof` are non-empty strings.
 * - Does not contact any facilitator or verify balances.
 */
export function parsePaymentSignatureHeader(
  raw: string | null,
): ParsePaymentSignatureResult {
  if (!raw || !raw.trim()) {
    return { ok: false, error: "missing Payment-Signature header" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Payment-Signature is not valid JSON" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "Payment-Signature must be a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;

  const scheme = obj.scheme;
  if (scheme !== "exact" && scheme !== "upto") {
    return { ok: false, error: 'scheme must be "exact" or "upto"' };
  }

  const network = stringField(obj.network);
  const payTo = stringField(obj.payTo);
  const nonce = stringField(obj.nonce);
  const proof = stringField(obj.proof);

  if (!network || !payTo || !nonce || !proof) {
    return {
      ok: false,
      error: "network, payTo, nonce, and proof must be non-empty strings",
    };
  }

  const price = stringField(obj.price);
  const maxAmount = stringField(obj.maxAmount);
  const minPrice = stringField(obj.minPrice);
  const expiresAt = stringField(obj.expiresAt);

  const value: PaymentSignaturePayload = {
    scheme,
    network,
    payTo,
    nonce,
    proof,
  };

  if (price) value.price = price;
  if (maxAmount) value.maxAmount = maxAmount;
  if (minPrice) value.minPrice = minPrice;
  if (expiresAt) value.expiresAt = expiresAt;

  return { ok: true, value };
}

function stringField(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}
