/**
 * Facilitator client for x402 settlement.
 *
 * Calls the CDP facilitator API to settle charges against authorized payments.
 * Handles timeouts and classifies errors as permanent vs transient.
 */

/**
 * Request payload for settlement.
 */
export interface SettleRequest {
  /** Authorization ID from x402 header verification */
  authId: string;
  /** Amount to charge (USD string, e.g. "$0.001") */
  amount: string;
  /** Idempotency key to prevent double-charging */
  idempotencyKey: string;
  /** Metadata about the registered content */
  metadata: {
    logId: string;
    contentHash: string;
  };
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
 * @returns Settlement response
 * @throws Error on network failure or timeout
 */
export async function settleCharge(
  facilitatorUrl: string,
  request: SettleRequest,
  timeoutMs: number,
): Promise<SettleResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${facilitatorUrl}/settle`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": request.idempotencyKey,
      },
      body: JSON.stringify({
        authorizationId: request.authId,
        amount: request.amount,
        metadata: request.metadata,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Classify response
    if (response.ok) {
      const data = (await response.json()) as { txHash?: string };
      return {
        ok: true,
        txHash: data.txHash,
      };
    }

    // Error response - classify as permanent or transient
    const errorBody = await response.text().catch(() => "");
    const errorMsg = `HTTP ${response.status}: ${errorBody}`.slice(0, 200);

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
