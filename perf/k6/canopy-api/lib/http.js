/**
 * HTTP helpers for k6 canopy-api load testing.
 *
 * Provides:
 * - POST /entries with COSE Sign1 payload
 * - 303 redirect parsing
 * - Sampled polling for e2e latency measurement
 */

import http from "k6/http";
import { Trend, Counter } from "k6/metrics";

// Custom metrics
export const postLatency = new Trend("post_latency", true);
export const e2eLatencySampled = new Trend("e2e_latency_sampled", true);
export const postErrors = new Counter("post_errors");
export const pollErrors = new Counter("poll_errors");

// Shared state for sampled polling (populated by writer, consumed by poller)
// Note: In k6, this is per-VU, so we use a simple approach where each VU
// tracks its own sampled requests.
const sampledRequests = [];

/**
 * POST a COSE Sign1 statement to /entries.
 *
 * @param {string} baseUrl - Base URL (e.g., https://canopy-api.example.workers.dev)
 * @param {string} logId - Log ID for the target log
 * @param {string} apiToken - Bearer token for Authorization
 * @param {Uint8Array} cosePayload - CBOR-encoded COSE Sign1 message
 * @param {number} [sampleRate=0] - Probability (0-1) of sampling for e2e polling
 * @returns {Object} - { success, statusCode, statusUrl, error, startTime }
 */
export function postEntry(baseUrl, logId, apiToken, cosePayload, sampleRate = 0) {
  const url = `${baseUrl}/logs/${logId}/entries`;
  const startTime = Date.now();

  const response = http.post(url, cosePayload.buffer, {
    headers: {
      "Content-Type": 'application/cose; cose-type="cose-sign1"',
      Authorization: `Bearer ${apiToken}`,
    },
    redirects: 0, // Don't follow redirects, we want the 303
  });

  const latency = Date.now() - startTime;
  postLatency.add(latency);

  // Check for 303 See Other
  if (response.status === 303) {
    const statusUrl = response.headers["Location"];
    if (statusUrl) {
      // Sample for e2e polling?
      if (sampleRate > 0 && Math.random() < sampleRate) {
        sampledRequests.push({ statusUrl, startTime });
      }

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

    // Sleep before next poll
    // Note: k6's sleep is in seconds
    if (i < maxPolls - 1) {
      // eslint-disable-next-line no-undef
      __ENV.K6_POLL_SLEEP && sleep(pollIntervalMs / 1000);
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
 * Process sampled requests for e2e latency measurement.
 * Call this periodically from the poller scenario.
 *
 * @param {string} apiToken - Bearer token for Authorization
 * @param {number} [maxPolls=60] - Maximum polls per request
 * @param {number} [pollIntervalMs=250] - Milliseconds between polls
 * @returns {number} - Number of requests processed
 */
export function processSampledRequests(
  apiToken,
  maxPolls = 60,
  pollIntervalMs = 250
) {
  let processed = 0;

  while (sampledRequests.length > 0) {
    const req = sampledRequests.shift();
    const result = pollUntilSequenced(
      req.statusUrl,
      apiToken,
      maxPolls,
      pollIntervalMs
    );

    if (result.success) {
      const e2eLatency = Date.now() - req.startTime;
      e2eLatencySampled.add(e2eLatency);
    }

    processed++;
  }

  return processed;
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
