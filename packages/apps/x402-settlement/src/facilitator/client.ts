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
  /** The authorization's validity window had closed (permanent, not the payer's fault). */
  expired?: boolean;
}

/**
 * x402 `errorReason` values meaning the facilitator could not get its
 * settlement transaction mined. They are transient: worth another attempt
 * while the authorization is valid. They do NOT prove the authorization is
 * unspent (the reference facilitator returns them when its receipt wait
 * fails after broadcast), which is why the DO reads the token contract
 * before and after each attempt (authorization-state.ts).
 *
 * - `invalid_exact_evm_transaction_failed`: what x402.org returned, with
 *   HTTP 200, for 6 of 15 lane-A settlements on 2026-10-24 (FOR-616).
 * - `transaction_failed`: the same failure as `@x402/evm` 2.2.0's
 *   `ExactEvmScheme.settle` names it (a self-hosted or CDP facilitator).
 * - `unexpected_settle_error`: catch-all some facilitator builds return for
 *   a settle that threw before it could classify the failure.
 */
const TRANSIENT_ERROR_REASONS = new Set([
  "invalid_exact_evm_transaction_failed",
  "transaction_failed",
  "unexpected_settle_error",
]);

/**
 * x402 `errorReason` values meaning the authorization's validity window has
 * closed (`@x402/evm` 2.2.0 verify). Not the payer's fault when canopy's own
 * retry arrives late, so these never count toward payer blocking.
 */
const EXPIRED_ERROR_REASONS = new Set([
  "invalid_exact_evm_payload_authorization_valid_before",
]);

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

    // Classify response. The abort timer stays armed until the body is read:
    // a stalled body is as much a timeout as stalled headers.
    const responseText = await response.text();
    clearTimeout(timeoutId);
    console.log("settleCharge response", {
      status: response.status,
      body: responseText.slice(0, 500),
    });

    if (response.ok) {
      const data = JSON.parse(responseText) as {
        success?: boolean;
        transaction?: string;
        network?: string;
        errorReason?: string;
      };
      // CDP returns { success: true, transaction: "0x...", network: "..." }
      if (data.success && data.transaction) {
        return {
          ok: true,
          txHash: data.transaction,
        };
      }
      // A 2xx refusal is permanent unless the facilitator says its own
      // transaction failed, in which case a later attempt may settle it
      // (FOR-616).
      const reason = data.errorReason ?? "";
      return {
        ok: false,
        error: `Unexpected response: ${responseText.slice(0, 200)}`,
        permanent: !TRANSIENT_ERROR_REASONS.has(reason),
        ...(EXPIRED_ERROR_REASONS.has(reason) ? { expired: true } : {}),
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
