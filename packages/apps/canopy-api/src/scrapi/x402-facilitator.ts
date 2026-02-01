/**
 * x402 facilitator client for verify and settle operations.
 *
 * Calls the CDP x402 API directly with JWT authentication for payment
 * verification. Settlement is handled asynchronously via the x402-settlement
 * worker and queue.
 */

import type {
  VerifiedPayment,
  PaymentPayload,
  PaymentRequirementsOption,
} from "./x402";
import type { X402Mode } from "../index";

/**
 * CDP API credentials for JWT authentication.
 */
export interface CdpCredentials {
  keyId: string;
  keySecret: string;
}

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
 * Verify a payment payload with the CDP facilitator.
 *
 * In verify-only mode, returns success without calling the facilitator.
 * In verify-and-settle mode, calls CDP /verify directly with JWT auth.
 */
export async function verifyPayment(
  payment: VerifiedPayment,
  requirements: PaymentRequirementsOption,
  mode: X402Mode,
  config: {
    facilitatorUrl?: string;
    verifyTimeoutMs?: number;
    cdpCredentials?: CdpCredentials;
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
    // Standard x402 facilitator /verify request body.
    // CDP expects: { x402Version, paymentPayload, paymentRequirements }
    const body = {
      x402Version: payment.payload.x402Version,
      paymentPayload: payment.payload,
      paymentRequirements: requirements,
    };

    // Build headers - add JWT auth if CDP credentials provided
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (config.cdpCredentials) {
      const jwt = await generateCdpJwt(
        config.cdpCredentials.keyId,
        config.cdpCredentials.keySecret,
        `POST ${new URL(config.facilitatorUrl).host}/platform/v2/x402/verify`,
      );
      headers["Authorization"] = `Bearer ${jwt}`;
    }

    const res = await fetch(
      `${config.facilitatorUrl.replace(/\/$/, "")}/verify`,
      {
        method: "POST",
        headers,
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
    // Standard x402 facilitator /settle request body.
    // CDP expects: { x402Version, paymentPayload, paymentRequirements }
    const body = {
      x402Version: payment.payload.x402Version,
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

/**
 * Generate a CDP API JWT for authentication.
 *
 * CDP uses ES256 (ECDSA with P-256 and SHA-256).
 */
async function generateCdpJwt(
  keyId: string,
  keySecret: string,
  uri: string,
): Promise<string> {
  const header = {
    alg: "ES256",
    kid: keyId,
    typ: "JWT",
    nonce: crypto.randomUUID(),
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: keyId,
    iss: "cdp",
    nbf: now,
    exp: now + 120,
    uri,
  };

  const base64UrlEncode = (data: Uint8Array): string =>
    btoa(String.fromCharCode(...data))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  const jsonToBase64Url = (obj: unknown): string =>
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));

  const headerB64 = jsonToBase64Url(header);
  const payloadB64 = jsonToBase64Url(payload);
  const message = `${headerB64}.${payloadB64}`;

  const privateKey = await importPemKey(keySecret);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(message),
  );

  const signatureB64 = base64UrlEncode(new Uint8Array(signature));

  return `${message}.${signatureB64}`;
}

/**
 * Import a PEM-encoded EC private key for use with SubtleCrypto.
 */
async function importPemKey(pemKey: string): Promise<CryptoKey> {
  let normalized = pemKey.replace(/\\n/g, "\n").trim();

  if (normalized.includes("-----BEGIN")) {
    const pemMatch = normalized.match(
      /-----BEGIN[^-]+-----([^-]+)-----END[^-]+-----/,
    );
    if (!pemMatch) {
      throw new Error("Invalid PEM format");
    }
    normalized = pemMatch[1].replace(/\s/g, "");
  }

  const binaryString = atob(normalized);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      bytes.buffer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch (pkcs8Error) {
    throw new Error(
      `Failed to import key: ${pkcs8Error instanceof Error ? pkcs8Error.message : String(pkcs8Error)}`,
    );
  }
}
