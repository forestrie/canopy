/**
 * Facilitator client for x402 settlement.
 *
 * Calls the CDP facilitator API to settle charges against authorized payments.
 * Handles timeouts and classifies errors as permanent vs transient.
 */

import type {
  PaymentPayload,
  PaymentRequirementsOption,
} from "@canopy/x402-settlement-types";
import { generateCdpJwt } from "../cdp-jwt.js";

/**
 * CDP API credentials for JWT authentication.
 */
export interface CdpCredentials {
  keyId: string;
  keySecret: string;
}

/**
 * Request payload for settlement.
 */
export interface SettleRequest {
  /** Full x402 payment payload */
  paymentPayload: PaymentPayload;
  /** Payment requirements that were accepted */
  paymentRequirements: PaymentRequirementsOption;
  /** Idempotency key to prevent double-charging */
  idempotencyKey: string;
}

/**
 * Response from facilitator settlement call.
 */
export interface SettleResponse {
  /** Whether settlement succeeded */
  ok: boolean;
  /** Transaction hash if successful */
  txHash?: string;
  /** Error message if failed */
  error?: string;
  /** Whether the error is permanent (no retry) */
  permanent?: boolean;
}

/**
 * Settle a charge against an x402 authorization.
 *
 * @param facilitatorUrl - Base URL of the facilitator API
 * @param request - Settlement request details
 * @param timeoutMs - Request timeout in milliseconds
 * @param cdpCredentials - Optional CDP credentials for JWT auth (required for direct CDP calls)
 * @returns Settlement response
 * @throws Error on network failure or timeout
 */
export async function settleCharge(
  facilitatorUrl: string,
  request: SettleRequest,
  timeoutMs: number,
  cdpCredentials?: CdpCredentials,
): Promise<SettleResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${facilitatorUrl}/settle`;

    // Build x402 settle request body - same format as verify
    const body = {
      x402Version: request.paymentPayload.x402Version,
      paymentPayload: request.paymentPayload,
      paymentRequirements: request.paymentRequirements,
    };

    console.log("settleCharge request", {
      url,
      idempotencyKey: request.idempotencyKey,
      x402Version: body.x402Version,
      hasCredentials: !!cdpCredentials,
    });

    // Build headers - add JWT auth if credentials provided
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Idempotency-Key": request.idempotencyKey,
    };

    if (cdpCredentials) {
      const jwt = await generateCdpJwt(
        cdpCredentials.keyId,
        cdpCredentials.keySecret,
        `POST ${new URL(facilitatorUrl).host}/platform/v2/x402/settle`,
      );
      headers["Authorization"] = `Bearer ${jwt}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Classify response
    const responseText = await response.text();
    console.log("settleCharge response", {
      status: response.status,
      body: responseText.slice(0, 500),
    });

    if (response.ok) {
      const data = JSON.parse(responseText) as {
        success?: boolean;
        transaction?: string;
        network?: string;
      };
      // CDP returns { success: true, transaction: "0x...", network: "..." }
      if (data.success && data.transaction) {
        return {
          ok: true,
          txHash: data.transaction,
        };
      }
      // If response was 2xx but not success, treat as error
      return {
        ok: false,
        error: `Unexpected response: ${responseText.slice(0, 200)}`,
        permanent: true,
      };
    }

    // Error response - classify as permanent or transient
    const errorMsg = `HTTP ${response.status}: ${responseText}`.slice(0, 200);

    // Permanent errors: client errors that won't succeed on retry
    // 400: Bad request (invalid parameters)
    // 402: Payment required (insufficient funds or auth revoked)
    // 404: Authorization not found
    // 410: Authorization expired/gone
    // 422: Unprocessable (validation failed)
    const permanentCodes = [400, 402, 404, 410, 422];
    const isPermanent = permanentCodes.includes(response.status);

    return {
      ok: false,
      error: errorMsg,
      permanent: isPermanent,
    };
  } catch (err) {
    clearTimeout(timeoutId);

    // AbortError means timeout
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Timeout after ${timeoutMs}ms`);
    }

    // Other errors (network failures) are transient
    throw err;
  }
}
