import { keccak_256 } from "@noble/hashes/sha3";

export type PaymentScheme = "exact" | "upto";

export interface BasePaymentFields {
  scheme: PaymentScheme;
  network: string;
  payTo: `0x${string}`;
  resource: string;
  nonce: string;
}

export interface UptoPaymentFields extends BasePaymentFields {
  scheme: "upto";
  maxAmount: string;
  minPrice: string;
}

export interface ExactPaymentFields extends BasePaymentFields {
  scheme: "exact";
  amount: string;
}

export type PaymentPayload = UptoPaymentFields | ExactPaymentFields;

const textEncoder = new TextEncoder();

/**
 * Serialize payment payload into a canonical string for signing.
 *
 * This is a Phase 2a implementation detail: we control both the client and
 * server, so we only need internal stability, not cross-ecosystem
 * compatibility.
 */
export function serializePaymentForSigning(
  payload: PaymentPayload,
): Uint8Array {
  const parts: string[] = [
    "x402-canopy-payment",
    `scheme:${payload.scheme}`,
    `network:${payload.network}`,
    `payTo:${payload.payTo}`,
    `resource:${payload.resource}`,
    `nonce:${payload.nonce}`,
  ];

  if (payload.scheme === "upto") {
    parts.push(`maxAmount:${payload.maxAmount}`);
    parts.push(`minPrice:${payload.minPrice}`);
  } else {
    parts.push(`amount:${payload.amount}`);
  }

  const message = parts.join("|");
  return textEncoder.encode(message);
}

/**
 * Hash payment payload into a 32-byte keccak-256 digest suitable for
 * secp256k1 signing.
 */
export function hashPayment(payload: PaymentPayload): Uint8Array {
  const msg = serializePaymentForSigning(payload);
  return keccak_256(msg);
}
