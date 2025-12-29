/**
 * write-constant-arrival.js
 *
 * k6 scenario for sustained write load against canopy-api /entries endpoint.
 * Uses constant-arrival-rate executor to maintain a fixed request rate
 * regardless of response times.
 *
 * Environment variables:
 *   CANOPY_PERF_BASE_URL   - Base URL of canopy-api (required)
 *   CANOPY_PERF_API_TOKEN  - Bearer token for Authorization (required)
 *   CANOPY_PERF_LOG_ID     - Target log ID (required)
 *   CANOPY_PERF_RATE       - Requests per second (default: 10)
 *   CANOPY_PERF_DURATION   - Stage duration (default: 3m)
 *   CANOPY_PERF_WARMUP     - Warmup duration (default: 30s)
 *   CANOPY_PERF_MSG_BYTES  - Payload size in bytes (default: 64)
 *   CANOPY_PERF_SAMPLE_RATE - Fraction of requests to sample for e2e (default: 0.01)
 *
 * Example:
 *   CANOPY_PERF_BASE_URL=https://canopy-api.example.workers.dev \
 *   CANOPY_PERF_API_TOKEN=your-token \
 *   CANOPY_PERF_LOG_ID=your-log-id \
 *   CANOPY_PERF_RATE=100 \
 *   k6 run scenarios/write-constant-arrival.js
 */

import { check } from "k6";
import { encodeCoseSign1, generateUniquePayload } from "../lib/cose.js";
import {
  postAndMaybeWait,
  postLatency,
  postErrors,
  e2eLatency,
  e2eSuccessCount,
  e2eTimeoutCount,
  pollCount,
} from "../lib/http.js";

// Read configuration from environment
// Note: We use CANOPY_PERF_ prefix instead of K6_ to avoid k6's built-in
// environment variable handling which can override scenario configuration.
const BASE_URL = __ENV.CANOPY_PERF_BASE_URL;
const API_TOKEN = __ENV.CANOPY_PERF_API_TOKEN;
const LOG_ID = __ENV.CANOPY_PERF_LOG_ID;
const RATE = parseInt(__ENV.CANOPY_PERF_RATE || "10", 10);
const DURATION = __ENV.CANOPY_PERF_DURATION || "3m";
const WARMUP = __ENV.CANOPY_PERF_WARMUP || "30s";
const MSG_BYTES = parseInt(__ENV.CANOPY_PERF_MSG_BYTES || "64", 10);
const SAMPLE_RATE = parseFloat(__ENV.CANOPY_PERF_SAMPLE_RATE || "0.01");

// Validate required environment variables
if (!BASE_URL) {
  throw new Error("CANOPY_PERF_BASE_URL is required");
}
if (!API_TOKEN) {
  throw new Error("CANOPY_PERF_API_TOKEN is required");
}
if (!LOG_ID) {
  throw new Error("CANOPY_PERF_LOG_ID is required");
}

// k6 options
export const options = {
  scenarios: {
    // Warmup: ramp from 0 to target rate
    warmup: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      stages: [{ duration: WARMUP, target: RATE }],
      preAllocatedVUs: Math.max(10, Math.ceil(RATE / 10)),
      maxVUs: Math.max(50, RATE * 2),
      gracefulStop: "10s",
    },
    // Main: sustained constant rate
    sustained: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.max(10, Math.ceil(RATE / 10)),
      maxVUs: Math.max(50, RATE * 2),
      startTime: WARMUP,
      gracefulStop: "30s",
    },
  },

  // Thresholds for pass/fail
  thresholds: {
    // 99% of POST requests should complete under 5s
    post_latency: ["p(99)<5000"],
    // Error rate should be under 1%
    post_errors: ["count<" + Math.ceil(RATE * parseDuration(DURATION) * 0.01)],
    // HTTP request duration (built-in)
    http_req_duration: ["p(95)<3000", "p(99)<5000"],
    // HTTP failure rate
    http_req_failed: ["rate<0.01"],
  },

  // Summary output
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
};

// Parse duration string to seconds
function parseDuration(dur) {
  const match = dur.match(/^(\d+)(s|m|h)$/);
  if (!match) return 180; // default 3m
  const val = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "s") return val;
  if (unit === "m") return val * 60;
  if (unit === "h") return val * 3600;
  return 180;
}

// Counter for unique payloads per VU
let vuCounter = 0;

// Setup function - runs once per VU at start
export function setup() {
  console.log(`k6 write-constant-arrival starting`);
  console.log(`  Target: ${BASE_URL}/logs/${LOG_ID}/entries`);
  console.log(`  Rate: ${RATE} req/s`);
  console.log(`  Duration: ${WARMUP} warmup + ${DURATION} sustained`);
  console.log(`  Payload: ${MSG_BYTES} bytes`);
  console.log(`  Sample rate: ${SAMPLE_RATE * 100}%`);

  return {
    baseUrl: BASE_URL,
    apiToken: API_TOKEN,
    logId: LOG_ID,
    msgBytes: MSG_BYTES,
    sampleRate: SAMPLE_RATE,
  };
}

// Main VU function - called once per iteration
export default function (data) {
  // Generate unique payload for this request
  const payload = generateUniquePayload(data.msgBytes);
  const coseSign1 = encodeCoseSign1(payload);

  // Decide if this request should measure e2e latency (sampled)
  const measureE2E = data.sampleRate > 0 && Math.random() < data.sampleRate;

  // POST the statement (and optionally wait for sequencing)
  const result = postAndMaybeWait(
    data.baseUrl,
    data.logId,
    data.apiToken,
    coseSign1,
    measureE2E,
    60, // maxPolls
    250 // pollIntervalMs
  );

  // Check the result
  check(result, {
    "POST returned 303": (r) => r.statusCode === 303,
    "POST has status URL": (r) => r.statusUrl !== null,
  });

  if (measureE2E) {
    check(result, {
      "e2e sequencing succeeded": (r) => r.e2eSuccess === true,
    });
  }

  if (!result.success) {
    console.error(`POST failed: ${result.error}`);
  }
}

// Teardown function - runs once at end
export function teardown(data) {
  console.log(`k6 write-constant-arrival completed`);
}

// Handle summary output
export function handleSummary(data) {
  // Extract key metrics for summary
  const summary = {
    timestamp: new Date().toISOString(),
    config: {
      baseUrl: BASE_URL,
      logId: LOG_ID,
      rate: RATE,
      duration: DURATION,
      warmup: WARMUP,
      msgBytes: MSG_BYTES,
      sampleRate: SAMPLE_RATE,
    },
    metrics: {},
  };

  // Extract post_latency if available
  if (data.metrics.post_latency) {
    summary.metrics.post_latency = {
      avg: data.metrics.post_latency.values.avg,
      min: data.metrics.post_latency.values.min,
      med: data.metrics.post_latency.values.med,
      max: data.metrics.post_latency.values.max,
      p90: data.metrics.post_latency.values["p(90)"],
      p95: data.metrics.post_latency.values["p(95)"],
      p99: data.metrics.post_latency.values["p(99)"],
    };
  }

  // Get e2e sample counts first (Counter metrics have values.count)
  const e2eSuccessCount = data.metrics.e2e_success_count
    ? data.metrics.e2e_success_count.values.count
    : 0;
  const e2eTimeoutCount = data.metrics.e2e_timeout_count
    ? data.metrics.e2e_timeout_count.values.count
    : 0;

  // Extract e2e_latency if available (sampled requests that completed)
  // Note: k6 Trend metrics don't have count in values, use e2e_success_count
  if (data.metrics.e2e_latency && e2eSuccessCount > 0) {
    const e2eVals = data.metrics.e2e_latency.values;
    summary.metrics.e2e_latency = {
      count: e2eSuccessCount,
      avg: e2eVals.avg,
      min: e2eVals.min,
      med: e2eVals.med,
      max: e2eVals.max,
      p90: e2eVals["p(90)"],
      p95: e2eVals["p(95)"],
      p99: e2eVals["p(99)"],
    };
  }

  // Extract poll_count if available
  if (data.metrics.poll_count && e2eSuccessCount > 0) {
    const pollVals = data.metrics.poll_count.values;
    summary.metrics.poll_count = {
      avg: pollVals.avg,
      max: pollVals.max,
    };
  }

  // Store e2e success/timeout counts
  if (e2eSuccessCount > 0) {
    summary.metrics.e2e_success_count = e2eSuccessCount;
  }
  if (e2eTimeoutCount > 0) {
    summary.metrics.e2e_timeout_count = e2eTimeoutCount;
  }

  // Extract http_reqs for throughput
  if (data.metrics.http_reqs) {
    summary.metrics.http_reqs = {
      count: data.metrics.http_reqs.values.count,
      rate: data.metrics.http_reqs.values.rate,
    };
  }

  // Extract errors
  if (data.metrics.post_errors) {
    summary.metrics.post_errors = {
      count: data.metrics.post_errors.values.count,
    };
  }

  // Thresholds pass/fail
  summary.thresholds = {};
  for (const [name, threshold] of Object.entries(data.metrics)) {
    if (threshold.thresholds) {
      summary.thresholds[name] = {};
      for (const [tName, tData] of Object.entries(threshold.thresholds)) {
        summary.thresholds[name][tName] = tData.ok;
      }
    }
  }

  // Console output
  console.log("\n=== Custom Summary ===");
  console.log(JSON.stringify(summary, null, 2));

  // Return standard k6 summary (stdout) plus JSON file
  return {
    stdout: textSummary(data, { indent: "  ", enableColors: true }),
    "summary.json": JSON.stringify(summary, null, 2),
  };
}

// Simple text summary helper
function textSummary(data, options) {
  const lines = [];
  lines.push("\n=== k6 write-constant-arrival Summary ===\n");
  lines.push(`Target: ${BASE_URL}/logs/${LOG_ID}/entries`);
  lines.push(`Rate: ${RATE} req/s, Duration: ${WARMUP} warmup + ${DURATION}`);
  lines.push("");

  if (data.metrics.http_reqs) {
    lines.push(
      `Total requests: ${data.metrics.http_reqs.values.count.toFixed(0)}`
    );
    lines.push(
      `Achieved rate: ${data.metrics.http_reqs.values.rate.toFixed(2)} req/s`
    );
  }

  if (data.metrics.post_latency) {
    const pl = data.metrics.post_latency.values;
    lines.push(`\nPOST latency (time to 303):`);
    lines.push(`  avg: ${pl.avg.toFixed(0)}ms`);
    lines.push(`  p95: ${pl["p(95)"].toFixed(0)}ms`);
    lines.push(`  p99: ${pl["p(99)"].toFixed(0)}ms`);
    lines.push(`  max: ${pl.max.toFixed(0)}ms`);
  }

  // Use e2e_success_count for sample count since Trend doesn't have count
  const e2eSuccessCnt = data.metrics.e2e_success_count
    ? data.metrics.e2e_success_count.values.count
    : 0;
  if (data.metrics.e2e_latency && e2eSuccessCnt > 0) {
    const e2e = data.metrics.e2e_latency.values;
    lines.push(`\nE2E latency (POST to sequenced, sampled):`);
    lines.push(`  samples: ${e2eSuccessCnt}`);
    lines.push(`  avg: ${e2e.avg.toFixed(0)}ms`);
    lines.push(`  p95: ${e2e["p(95)"].toFixed(0)}ms`);
    lines.push(`  p99: ${e2e["p(99)"].toFixed(0)}ms`);
    lines.push(`  max: ${e2e.max.toFixed(0)}ms`);
  }

  if (data.metrics.post_errors) {
    lines.push(`\nErrors: ${data.metrics.post_errors.values.count}`);
  }

  if (data.metrics.e2e_timeout_count && data.metrics.e2e_timeout_count.values.count > 0) {
    lines.push(`E2E timeouts: ${data.metrics.e2e_timeout_count.values.count}`);
  }

  lines.push("\nThresholds:");
  let allPassed = true;
  for (const [name, metric] of Object.entries(data.metrics)) {
    if (metric.thresholds) {
      for (const [tName, tData] of Object.entries(metric.thresholds)) {
        const status = tData.ok ? "✓" : "✗";
        if (!tData.ok) allPassed = false;
        lines.push(`  ${status} ${name}: ${tName}`);
      }
    }
  }

  lines.push(`\nOverall: ${allPassed ? "PASSED" : "FAILED"}`);

  return lines.join("\n");
}
