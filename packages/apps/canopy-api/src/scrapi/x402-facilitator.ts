/**
 * x402 facilitator client for verify and settle operations.
 *
 * Uses the standard x402 facilitator API format.
 */

import type {
  VerifiedPayment,
  PaymentPayload,
  PaymentRequirementsOption,
} from "./x402";
import type { X402Mode } from "../index";

export type VerifyResult =
  | {
      ok: true;
      /** Identifier for this payment authorization */
      authId: string;
      /** Whether the payment is valid */
      isValid: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export type SettleResult =
  | {
      ok: true;
      /** Transaction hash from settlement */
      transaction: string;
      /** Network the settlement occurred on */
      network: string;
    }
  | {
      ok: false;
      error: string;
      /** Whether this is a permanent error (should not retry) */
      permanent?: boolean;
    };

/**
 * Verify a payment payload with the facilitator.
 *
 * In verify-only mode, returns success without calling the facilitator.
 * In verify-and-settle mode, calls the facilitator /verify endpoint.
 */
export async function verifyPayment(
  payment: VerifiedPayment,
  requirements: PaymentRequirementsOption,
  mode: X402Mode,
  config: {
    facilitatorUrl?: string;
    verifyTimeoutMs?: number;
  },
): Promise<VerifyResult> {
  const baseAuthId = `local:${payment.payerAddress}`;

  // In verify-only mode, trust the local payload validation
  if (mode === "verify-only") {
    return { ok: true, authId: baseAuthId, isValid: true };
  }

  if (!config.facilitatorUrl) {
    return { ok: false, error: "x402 facilitator URL not configured" };
  }

  const controller = new AbortController();
  const timeoutMs = config.verifyTimeoutMs ?? 5000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Standard x402 facilitator /verify request body
    const body = {
      paymentPayload: payment.payload,
      paymentRequirements: requirements,
    };

    const res = await fetch(
      `${config.facilitatorUrl.replace(/\/$/, "")}/verify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      let message = `facilitator verify failed with status ${res.status}`;
      try {
        const text = await res.text();
        if (text) message += `: ${text.slice(0, 500)}`;
      } catch {
        // ignore
      }
      return { ok: false, error: message };
    }

    const data = (await res.json()) as {
      isValid?: boolean;
      invalidReason?: string;
      error?: string;
    };

    if (data.isValid === false) {
      return {
        ok: false,
        error: data.invalidReason ?? data.error ?? "payment invalid",
      };
    }

    return {
      ok: true,
      authId: baseAuthId,
      isValid: true,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "facilitator verify timed out" };
    }
    return {
      ok: false,
      error: `facilitator verify error: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Settle a payment via the facilitator.
 *
 * This submits the payment to the blockchain and waits for confirmation.
 */
export async function settlePayment(
  payment: VerifiedPayment,
  requirements: PaymentRequirementsOption,
  config: {
    facilitatorUrl: string;
    settleTimeoutMs?: number;
  },
): Promise<SettleResult> {
  const controller = new AbortController();
  const timeoutMs = config.settleTimeoutMs ?? 30000; // 30s for on-chain settlement
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Standard x402 facilitator /settle request body
    const body = {
      paymentPayload: payment.payload,
      paymentRequirements: requirements,
    };

    const res = await fetch(
      `${config.facilitatorUrl.replace(/\/$/, "")}/settle`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      let message = `facilitator settle failed with status ${res.status}`;
      let permanent = false;
      try {
        const text = await res.text();
        if (text) {
          message += `: ${text.slice(0, 500)}`;
          // Check for permanent errors (invalid signature, insufficient funds, etc.)
          if (
            text.includes("invalid_signature") ||
            text.includes("insufficient_funds") ||
            text.includes("expired")
          ) {
            permanent = true;
          }
        }
      } catch {
        // ignore
      }
      return { ok: false, error: message, permanent };
    }

    const data = (await res.json()) as {
      success?: boolean;
      transaction?: string;
      network?: string;
      error?: string;
    };

    if (!data.success || !data.transaction) {
      return {
        ok: false,
        error: data.error ?? "settlement failed",
        permanent: true,
      };
    }

    return {
      ok: true,
      transaction: data.transaction,
      network: data.network ?? payment.network,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "facilitator settle timed out" };
    }
    return {
      ok: false,
      error: `facilitator settle error: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
