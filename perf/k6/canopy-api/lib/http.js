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

// Custom metrics
export const postLatency = new Trend("post_latency", true);
export const e2eLatency = new Trend("e2e_latency", true);
export const pollCount = new Trend("poll_count", true);
export const postErrors = new Counter("post_errors");
export const pollErrors = new Counter("poll_errors");
export const e2eSuccessCount = new Counter("e2e_success_count");
export const e2eTimeoutCount = new Counter("e2e_timeout_count");

/**
 * POST a COSE Sign1 statement to /entries.
 *
 * @param {string} baseUrl - Base URL (e.g., https://canopy-api.example.workers.dev)
 * @param {string} logId - Log ID for the target log
 * @param {string} apiToken - Bearer token for Authorization
 * @param {Uint8Array} cosePayload - CBOR-encoded COSE Sign1 message
 * @returns {Object} - { success, statusCode, statusUrl, error, startTime }
 */
export function postEntry(baseUrl, logId, apiToken, cosePayload) {
  const url = `${baseUrl}/logs/${logId}/entries`;
  const startTime = Date.now();

  const response = http.post(url, cosePayload.buffer, {
    headers: {
      "Content-Type": 'application/cose; cose-type="cose-sign1"',
      Authorization: `Bearer ${apiToken}`,
    },
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
  pollIntervalMs = 250
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
  pollIntervalMs = 250
) {
  const postResult = postEntry(baseUrl, logId, apiToken, cosePayload);

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
    pollIntervalMs
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
