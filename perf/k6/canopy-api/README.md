# k6 Performance Tests for canopy-api

Sustained load testing using [k6](https://k6.io) with constant-arrival-rate
execution. These tests complement the burst-oriented smoke tests in
`taskfiles/scrapi.yml`.

## Prerequisites

Install k6:

```bash
# macOS
brew install k6

# Linux (Debian/Ubuntu)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Or via npm (slower but works everywhere)
npm install -g k6
```

Verify installation:

```bash
task perf:check
```

## Quick Start

Set environment variables:

```bash
export CANOPY_PERF_BASE_URL="https://canopy-api.example.workers.dev"
export CANOPY_PERF_API_TOKEN="your-api-token"
export CANOPY_PERF_LOG_ID="your-log-id"
```

Run a quick smoke test (5 req/s for 30s):

```bash
task perf:write:smoke
```

Run sustained load at a specific rate:

```bash
# 10 req/s for 3 minutes
task perf:write:10

# 100 req/s for 3 minutes
task perf:write:100

# Custom rate via environment
CANOPY_PERF_RATE=50 task perf:write:rate
```

## Environment Variables

Note: We use `CANOPY_PERF_` prefix (not `K6_`) to avoid conflicts with k6's
built-in environment variable handling which can override scenario config.

| Variable                 | Required | Default       | Description                            |
| ------------------------ | -------- | ------------- | -------------------------------------- |
| CANOPY_PERF_BASE_URL     | Yes      | -             | Base URL of canopy-api                 |
| CANOPY_PERF_API_TOKEN    | Yes      | test-api-key  | Bearer token for Authorization         |
| CANOPY_PERF_LOG_ID       | Yes      | -             | Target log ID                          |
| CANOPY_PERF_RATE         | No       | 10            | Requests per second                    |
| CANOPY_PERF_DURATION     | No       | 3m            | Sustained phase duration               |
| CANOPY_PERF_WARMUP       | No       | 30s           | Warmup ramp duration                   |
| CANOPY_PERF_MSG_BYTES    | No       | 64            | Payload size in bytes                  |
| CANOPY_PERF_SAMPLE_RATE  | No       | 0.01          | Fraction of requests to sample for e2e |

## Task Targets

From the repository root:

```bash
# Check k6 installation
task perf:check

# Quick smoke test (5 req/s, 30s)
task perf:write:smoke

# Specific rates (3m duration each)
task perf:write:10    # 10 req/s
task perf:write:100   # 100 req/s
task perf:write:150   # 150 req/s
task perf:write:300   # 300 req/s

# Custom rate
CANOPY_PERF_RATE=75 task perf:write:rate

# Local development (wrangler dev on port 8787)
task perf:write:local:smoke
```

## Running Directly with k6

For more control, run k6 directly:

```bash
# From repository root
CANOPY_PERF_BASE_URL="https://canopy-api.example.workers.dev" \
CANOPY_PERF_API_TOKEN="your-token" \
CANOPY_PERF_LOG_ID="your-log-id" \
CANOPY_PERF_RATE=100 \
CANOPY_PERF_DURATION=5m \
k6 run perf/k6/canopy-api/scenarios/write-constant-arrival.js
```

k6 options can be overridden via CLI:

```bash
k6 run --duration 10m --vus 50 perf/k6/canopy-api/scenarios/write-constant-arrival.js
```

## Test Structure

```
perf/k6/canopy-api/
├── lib/
│   ├── cbor.js          # Minimal CBOR encoder (TypedArrays)
│   ├── cose.js          # COSE Sign1 encoder
│   └── http.js          # HTTP helpers, metrics
├── scenarios/
│   └── write-constant-arrival.js  # Main scenario
└── README.md
```

### Scenarios

**write-constant-arrival.js**: Sustained write load test

- Warmup phase: Ramps from 0 to target rate
- Sustained phase: Constant arrival rate
- Measures POST latency (custom metric) and HTTP metrics
- 1% sampling for end-to-end latency (when enabled)

### Thresholds

Default pass/fail thresholds:

- POST p99 latency < 5000ms
- Error rate < 1%
- HTTP duration p95 < 3000ms, p99 < 5000ms
- HTTP failure rate < 1%

## Output

Tests produce:

1. **Console summary**: Key metrics and threshold pass/fail
2. **summary.json**: JSON file with detailed metrics (written to CWD)

Example console output:

```
=== k6 write-constant-arrival Summary ===

Target: https://canopy-api.example.workers.dev/logs/abc123/entries
Rate: 100 req/s, Duration: 30s warmup + 3m

Total requests: 18150
Achieved rate: 99.72 req/s

POST latency:
  avg: 142ms
  p95: 285ms
  p99: 412ms
  max: 1523ms

Errors: 0

Thresholds:
  ✓ post_latency: p(99)<5000
  ✓ http_req_duration: p(95)<3000
  ✓ http_req_duration: p(99)<5000
  ✓ http_req_failed: rate<0.01

Overall: PASSED
```

## CBOR/COSE Implementation Notes

k6 runs on a custom JavaScript runtime (goja) without Node.js APIs. The lib/
directory contains pure-JavaScript implementations of:

- **CBOR encoding**: Major types 0 (uint), 2 (bstr), 4 (array), 5 (map)
- **COSE Sign1**: Minimal structure with empty signature (server validates
  format only)

These use `Uint8Array` and `ArrayBuffer` instead of Node.js `Buffer`.

## Comparison with Smoke Tests

| Aspect           | Smoke Tests (scrapi.yml)       | k6 Load Tests                |
| ---------------- | ------------------------------ | ---------------------------- |
| Load pattern     | Burst (all at once)            | Sustained (constant rate)    |
| Duration         | Seconds                        | Minutes                      |
| Concurrency      | Fixed parallel jobs            | Adaptive VUs                 |
| Metrics          | Throughput, simple timing      | Detailed latency percentiles |
| Use case         | Quick validation               | Capacity planning            |

Use smoke tests for quick CI validation. Use k6 for sustained load testing
and capacity analysis.
