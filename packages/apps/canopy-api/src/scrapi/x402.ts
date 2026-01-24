import { verifyPaymentSignature } from "@canopy/x402-signing";

// x402 helper functions for the yolo/Phase 2a (no-facilitator) phase.
//
// This module centralizes header names, nominal pricing, and JSON
// validation for the Payment-Required and Payment-Signature headers
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

/**
 * Minimal view of a verified payment we expose to the worker routing
 * layer. Detailed x402 semantics stay in the shared signing library.
 */
export interface VerifiedPaymentSignature {
  scheme: X402Scheme;
  network: string;
  payTo: string;
  /** Recovered payer wallet address (20-byte hex, 0x-prefixed). */
  payerAddress: `0x${string}`;
}

const NETWORK_SEPOLIA = "eip155:84532";
const PAYMENT_RESOURCE = "POST /logs/{logId}/entries";

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
    resource: PAYMENT_RESOURCE,
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
  | { ok: true; value: VerifiedPaymentSignature }
  | { ok: false; error: string };

/**
 * Parse and validate the Payment-Signature header.
 *
 * Phase 2a semantics:
 * - Ensures the header is present and parses as JSON.
 * - Delegates to @canopy/x402-signing to verify the ECDSA signature over a
 *   canonical payment payload, checking network/resource/payTo policy.
 * - Returns a recovered payer address on success.
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

  const verification = verifyPaymentSignature(parsed, {
    expectedNetwork: NETWORK_SEPOLIA,
    expectedResource: PAYMENT_RESOURCE,
    expectedPayTo: PAY_TO_TESTNET as `0x${string}`,
  });

  if (!verification.ok) {
    return { ok: false, error: verification.error };
  }

  const obj = parsed as Record<string, unknown>;
  const scheme = obj.scheme;
  if (scheme !== "exact" && scheme !== "upto") {
    return { ok: false, error: 'scheme must be "exact" or "upto"' };
  }

  const network = stringField(obj.network) ?? NETWORK_SEPOLIA;
  const payTo = stringField(obj.payTo) ?? PAY_TO_TESTNET;

  return {
    ok: true,
    value: {
      scheme,
      network,
      payTo,
      payerAddress: verification.payerAddress,
    },
  };
}

function stringField(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}
