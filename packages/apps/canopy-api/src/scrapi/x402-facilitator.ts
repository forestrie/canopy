import type { VerifiedPaymentSignature } from "./x402";
import type { X402Mode } from "../index";

export type VerifyAuthorizationResult =
  | {
      ok: true;
      authId: string;
      remainingAmount?: string;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * Synchronous authorization check for POST /logs/{logId}/entries.
 *
 * In Phase 2a and early 2b this is a stub that always succeeds, relying
 * solely on local signature verification. In a later Phase 2b cut this
 * will call an external x402 facilitator to confirm that the
 * authorization is live and has sufficient capacity.
 */
export async function verifyAuthorizationForRegister(
  verified: VerifiedPaymentSignature,
  mode: X402Mode,
  config: {
    facilitatorUrl?: string;
    network?: string;
    payTo?: string;
    verifyTimeoutMs?: number;
  },
): Promise<VerifyAuthorizationResult> {
  const baseAuthId = `local:${verified.payerAddress}`;

  // In verify-only mode, trust the local cryptographic verification and
  // skip the external check.
  if (mode === "verify-only") {
    return { ok: true, authId: baseAuthId };
  }

  if (!config.facilitatorUrl) {
    return {
      ok: false,
      error: "x402 facilitator URL not configured",
    };
  }

  const controller = new AbortController();
  const timeoutMs = config.verifyTimeoutMs ?? 2000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${config.facilitatorUrl.replace(/\/$/, "")}/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        payment: verified,
        requirements: {
          network: config.network,
          payTo: config.payTo,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let message = `facilitator verify failed with status ${res.status}`;
      try {
        const text = await res.text();
        if (text) {
          message += `: ${text.slice(0, 200)}`;
        }
      } catch {
        // ignore body parse errors
      }
      return { ok: false, error: message };
    }

    // Try to extract an authId from the facilitator response if present.
    try {
      const data = (await res.json()) as any;
      const authId: string | undefined =
        typeof data?.authId === "string"
          ? data.authId
          : typeof data?.authorizationId === "string"
            ? data.authorizationId
            : undefined;
      const remainingAmount: string | undefined =
        typeof data?.remainingAmount === "string" ? data.remainingAmount : undefined;

      return {
        ok: true,
        authId: authId ?? baseAuthId,
        remainingAmount,
      };
    } catch {
      // If we cannot parse JSON, fall back to the base auth id but
      // consider verification successful (the facilitator returned 2xx).
      return { ok: true, authId: baseAuthId };
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "facilitator verify timed out" };
    }
    return {
      ok: false,
      error: `facilitator verify error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    clearTimeout(timer);
  }
}
