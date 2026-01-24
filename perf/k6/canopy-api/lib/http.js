/**
 * HTTP helpers for k6 canopy-api load testing.
 *
 * Provides:
 * - POST /entries with COSE Sign1 payload
 * - 303 redirect parsing
 * - Inline sampled polling for e2e latency measurement
 */

import http from "k6/http";
import { sleep } from "k6";
import { Trend, Counter } from "k6/metrics";
import { buildAndSignUptoPayment } from "@canopy/x402-signing";

// Custom metrics
export const postLatency = new Trend("post_latency", true);
export const e2eLatency = new Trend("e2e_latency", true);
export const pollCount = new Trend("poll_count", true);
export const postErrors = new Counter("post_errors");
export const pollErrors = new Counter("poll_errors");
export const e2eSuccessCount = new Counter("e2e_success_count");
export const e2eTimeoutCount = new Counter("e2e_timeout_count");

/**
 * Perform a one-time x402 handshake to obtain a reusable Payment-Signature
 * header using the `upto` scheme.
 *
 * This is intended to be called from k6 `setup()` so that the main
 * performance test can attach the returned header to every POST without
 * incurring a 402 round-trip per request.
 *
 * The returned header is constructed using the shared @canopy/x402-signing
 * library so that the signing cost and payload structure match what the
 * worker verifies in Phase 2a.
 *
 * The signing key is taken from CANOPY_PERF_X402_PRIVATE_KEY if set, or a
 * deterministic built-in test key otherwise (Phase 2a has no real funds).
 *
 * @param {string} baseUrl - Base URL of canopy-api
 * @param {string} logId - Any valid log ID (first from the list is fine)
 * @param {string} apiToken - Bearer token for Authorization
 * @returns {string} - Serialized JSON Payment-Signature header value
 */
export function initPaymentSignatureUpto(baseUrl, logId, apiToken) {
  const url = `${baseUrl}/logs/${logId}/entries`;
  // Minimal body; the server will reject before parsing due to missing
  // Payment-Signature header and return 402 with Payment-Required.
  const dummyBody = new Uint8Array([0x80]);

  const response = http.post(url, dummyBody.buffer, {
    headers: {
      "Content-Type": 'application/cose; cose-type="cose-sign1"',
      Authorization: `Bearer ${apiToken}`,
    },
    redirects: 0,
    tags: { operation: "post_entry_handshake" },
  });

  if (response.status !== 402) {
    throw new Error(
      `Expected 402 Payment Required during x402 handshake, got ${response.status}`,
    );
  }

  const paymentRequired = response.headers["Payment-Required"];
  if (!paymentRequired) {
    throw new Error("Missing Payment-Required header in 402 response");
  }

  let payload;
  try {
    payload = JSON.parse(paymentRequired);
  } catch (e) {
    throw new Error("Payment-Required header is not valid JSON");
  }

  const options = (payload && payload.options) || [];
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error("Payment-Required.options is empty or invalid");
  }

  // Prefer the `upto` option; fall back to the first option if needed.
  let chosen = options.find((o) => o.scheme === "upto");
  if (!chosen) {
    chosen = options[0];
  }

  if (!chosen.network || !chosen.payTo || !chosen.price) {
    throw new Error("Chosen x402 option is missing network, payTo, or price");
  }

  const minPrice = chosen.minPrice || chosen.price;

  // Build a real x402 `upto` payment payload and sign it.
  // Use the shared dev payer key CANOPY_X402_DEV_PRIVATE_KEY by default,
  // with CANOPY_PERF_X402_PRIVATE_KEY as an optional override.
  // Fall back to a deterministic test key only if neither is set (Phase 2a).
  const privateKey =
    __ENV.CANOPY_PERF_X402_PRIVATE_KEY ||
    __ENV.CANOPY_X402_DEV_PRIVATE_KEY ||
    // 0x + 64 hex chars; arbitrary but stable dev-only key for Phase 2a testing.
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  const payment = buildAndSignUptoPayment(
    {
      network: chosen.network,
      payTo: chosen.payTo,
      resource: "POST /logs/{logId}/entries",
      maxAmount: chosen.price,
      minPrice,
    },
    { privateKey },
  );

  return JSON.stringify(payment);
}

/**
 * POST a COSE Sign1 statement to /entries.
 *
 * @param {string} baseUrl - Base URL (e.g., https://canopy-api.example.workers.dev)
 * @param {string} logId - Log ID for the target log
 * @param {string} apiToken - Bearer token for Authorization
 * @param {Uint8Array} cosePayload - CBOR-encoded COSE Sign1 message
 * @param {string} [paymentSignature] - Optional Payment-Signature header
 * @returns {Object} - { success, statusCode, statusUrl, error, startTime }
 */
export function postEntry(
  baseUrl,
  logId,
  apiToken,
  cosePayload,
  paymentSignature,
) {
  const url = `${baseUrl}/logs/${logId}/entries`;
  const startTime = Date.now();

  const headers = {
    "Content-Type": 'application/cose; cose-type="cose-sign1"',
    Authorization: `Bearer ${apiToken}`,
  };

  if (paymentSignature) {
    headers["Payment-Signature"] = paymentSignature;
  }

  const response = http.post(url, cosePayload.buffer, {
    headers,
    redirects: 0, // Don't follow redirects, we want the 303
    // Tag POST requests for metric filtering (distinct from poll_status)
    tags: { operation: "post_entry" },
  });

  const latency = Date.now() - startTime;
  postLatency.add(latency);

  // Check for 303 See Other
  if (response.status === 303) {
    const statusUrl = response.headers["Location"];
    if (statusUrl) {
      return {
        success: true,
        statusCode: 303,
        statusUrl,
        error: null,
        startTime,
      };
    }
  }

  // Error case
  postErrors.add(1);
  return {
    success: false,
    statusCode: response.status,
    statusUrl: null,
    error: response.body ? response.body.toString() : `HTTP ${response.status}`,
    startTime,
  };
}

/**
 * Poll a status URL until it returns a receipt URL.
 *
 * @param {string} statusUrl - The status URL from POST response
 * @param {string} apiToken - Bearer token for Authorization
 * @param {number} [maxPolls=60] - Maximum number of poll attempts
 * @param {number} [pollIntervalMs=250] - Milliseconds between polls
 * @returns {Object} - { success, receiptUrl, polls, error }
 */
export function pollUntilSequenced(
  statusUrl,
  apiToken,
  maxPolls = 60,
  pollIntervalMs = 250,
) {
  for (let i = 0; i < maxPolls; i++) {
    const response = http.get(statusUrl, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      redirects: 0,
      // Tag polling requests so they can be excluded from http_req_failed threshold
      tags: { operation: "poll_status" },
    });

    if (response.status === 303) {
      const location = response.headers["Location"];
      if (location && location.endsWith("/receipt")) {
        return {
          success: true,
          receiptUrl: location,
          polls: i + 1,
          error: null,
        };
      }
    }

    if (response.status >= 400) {
      pollErrors.add(1);
      return {
        success: false,
        receiptUrl: null,
        polls: i + 1,
        error: `HTTP ${response.status}`,
      };
    }

    // Sleep before next poll (k6's sleep is in seconds)
    if (i < maxPolls - 1) {
      sleep(pollIntervalMs / 1000);
    }
  }

  pollErrors.add(1);
  return {
    success: false,
    receiptUrl: null,
    polls: maxPolls,
    error: "timeout",
  };
}

/**
 * POST and optionally poll until sequenced (for sampled e2e latency).
 *
 * @param {string} baseUrl - Base URL
 * @param {string} logId - Log ID
 * @param {string} apiToken - Bearer token
 * @param {Uint8Array} cosePayload - CBOR-encoded COSE Sign1 message
 * @param {boolean} [measureE2E=false] - Whether to poll until sequenced
 * @param {number} [maxPolls=60] - Maximum poll attempts for e2e
 * @param {number} [pollIntervalMs=250] - Poll interval for e2e
 * @returns {Object} - { success, statusCode, statusUrl, e2eLatencyMs, polls, error }
 */
export function postAndMaybeWait(
  baseUrl,
  logId,
  apiToken,
  cosePayload,
  measureE2E = false,
  maxPolls = 60,
  pollIntervalMs = 250,
  paymentSignature,
) {
  const postResult = postEntry(
    baseUrl,
    logId,
    apiToken,
    cosePayload,
    paymentSignature,
  );

  if (!postResult.success || !measureE2E) {
    return {
      ...postResult,
      e2eLatencyMs: null,
      polls: 0,
    };
  }

  // Poll until sequenced
  const pollResult = pollUntilSequenced(
    postResult.statusUrl,
    apiToken,
    maxPolls,
    pollIntervalMs,
  );

  const e2eLatencyMs = Date.now() - postResult.startTime;

  if (pollResult.success) {
    e2eLatency.add(e2eLatencyMs);
    pollCount.add(pollResult.polls);
    e2eSuccessCount.add(1);
  } else {
    e2eTimeoutCount.add(1);
  }

  return {
    ...postResult,
    e2eLatencyMs,
    polls: pollResult.polls,
    e2eSuccess: pollResult.success,
    e2eError: pollResult.error,
  };
}

/**
 * Get queue stats from the forestrie-ingress debug endpoint.
 *
 * @param {string} ingressUrl - forestrie-ingress base URL
 * @param {string} apiToken - Bearer token
 * @param {number} [limit=100] - Number of recent entries to fetch
 * @returns {Object|null} - Parsed JSON response or null on error
 */
export function getQueueDebugRecent(ingressUrl, apiToken, limit = 100) {
  const url = `${ingressUrl}/queue/debug/recent?limit=${limit}`;

  const response = http.get(url, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
  });

  if (response.status === 200) {
    try {
      return JSON.parse(response.body);
    } catch (e) {
      return null;
    }
  }

  return null;
}

/**
 * Get queue stats summary.
 *
 * @param {string} ingressUrl - forestrie-ingress base URL
 * @param {string} apiToken - Bearer token
 * @returns {Object|null} - Parsed JSON response or null on error
 */
export function getQueueStats(ingressUrl, apiToken) {
  const url = `${ingressUrl}/queue/stats`;

  const response = http.get(url, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
  });

  if (response.status === 200) {
    try {
      return JSON.parse(response.body);
    } catch (e) {
      return null;
    }
  }

  return null;
}
