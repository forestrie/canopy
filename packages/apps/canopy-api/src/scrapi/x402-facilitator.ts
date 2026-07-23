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
import type { X402Mode } from "../env/x402-mode.js";
import type {
  CdpCredentials,
  SettleResult,
  VerifyResult,
} from "./x402-facilitator-result.js";

export type { CdpCredentials, SettleResult, VerifyResult } from "./types.js";

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
 * Generate a CDP API JWT (EdDSA) for authentication.
 *
 * CDP Secret API Keys are Ed25519 as of Feb 2025: a UUID id and a base64 secret
 * decoding to 64 bytes = seed(32) || publicKey(32); we sign with the seed half.
 * (Kept in sync with x402-settlement/src/cdp-jwt.ts. FOR-79.)
 */
async function generateCdpJwt(
  keyId: string,
  keySecret: string,
  uri: string,
): Promise<string> {
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const header = {
    alg: "EdDSA",
    kid: keyId,
    typ: "JWT",
    nonce: Array.from(nonceBytes, (b) => b.toString(16).padStart(2, "0")).join(
      "",
    ),
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

  const message = `${jsonToBase64Url(header)}.${jsonToBase64Url(payload)}`;

  const privateKey = await importCdpEd25519Key(keySecret);
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(message),
  );

  return `${message}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// RFC 8410 PKCS#8 prefix for an Ed25519 private key (wraps the 32-byte seed).
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);

/**
 * Import a CDP Ed25519 signing key from its base64 secret (seed||publicKey).
 */
async function importCdpEd25519Key(keySecret: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(keySecret.trim()), (c) => c.charCodeAt(0));
  if (raw.length !== 64) {
    throw new Error(
      `CDP_API_KEY_SECRET must be a base64 64-byte Ed25519 seed||publicKey ` +
        `(decoded ${raw.length} bytes). Legacy ECDSA keys are not supported.`,
    );
  }
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(raw.subarray(0, 32), PKCS8_ED25519_PREFIX.length);
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8.buffer as ArrayBuffer,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}
