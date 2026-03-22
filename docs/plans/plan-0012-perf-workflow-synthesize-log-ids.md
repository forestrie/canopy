---
Status: ACCEPTED
Date: 2026-03-21
Related:
  - [plan-0009](plan-0009-bootstrap-and-load-test-readiness.md)
  - `.github/workflows/perf-canopy.yml`
  - `perf/scripts/generate-shard-balanced-ids.js`
  - `perf/scripts/generate-grant-pool.ts`
---

# Plan 0012: Synthesize perf log IDs in CI (remove long-lived `CANOPY_PERF_*LPS_*` variables)

## Summary

**Implemented:** `.github/workflows/perf-canopy.yml` runs `node perf/scripts/generate-shard-balanced-ids.js --logs-per-shard … --format csv` and no longer reads **`CANOPY_PERF_*LPS_*`** from GitHub.

Previously the workflow expected up to **24** GitHub Environment variables named `CANOPY_PERF_1LPS_0` … `CANOPY_PERF_3LPS_11`, or values from committed `perf/.env.*` / the offline helper script.

Those IDs do **not** need to be long-lived: `generate-grant-pool.ts` already mints bootstrap grants **per arbitrary `rootLogId`** (`POST /api/grants/bootstrap` with `{ rootLogId }`), then registers and resolves each grant. Fresh UUIDs per run are appropriate as long as they are **shard-balanced** (djb2 % shardCount) when we care about even load across ingress shards.

This plan removes reliance on stored `CANOPY_PERF_*LPS_*` variables and generates the comma-separated `CANOPY_PERF_LOG_IDS` list inside the workflow (or via a small script step).

## Resulting behavior

| Location | Behavior |
|----------|----------|
| `.github/workflows/perf-canopy.yml` | Step **Build shard-balanced log ID list** runs `generate-shard-balanced-ids.js --format csv`; writes `log_ids` to `GITHUB_OUTPUT`. |
| `perf/scripts/generate-grant-pool.ts` | Unchanged: consumes `CANOPY_PERF_LOG_IDS`. |
| `perf/scripts/generate-shard-balanced-ids.js` | CLI: `--logs-per-shard` + `--format csv|env|json|human`; no args = legacy human + JSON dump. |
| `taskfiles/perf.yml` / `taskfiles/grant.yml` | Unchanged: local runs still pass `CANOPY_PERF_LOG_IDS` (or generate via script). |

## Target behavior

1. **CI perf workflow** produces `CANOPY_PERF_LOG_IDS` for the selected `logs_per_shard` (1, 2, or 3) **without** reading `CANOPY_PERF_*LPS_*` from GitHub.
2. **Shard count** stays aligned with production ingress (`QUEUE_SHARD_COUNT`, currently **4** in `forestrie-ingress` wrangler config); generation logic must keep using the same **djb2** rule as `@canopy/forestrie-sharding` / the existing script.
3. **Optional**: keep `generate-shard-balanced-ids.js` as the single implementation (CLI mode) so local dev and CI share one code path.

## Implemented

- `perf/scripts/generate-shard-balanced-ids.js`: `--logs-per-shard`, `--shard-count`, `--format csv|env|json|human`; legacy no-arg mode preserved.
- `perf-canopy.yml`: **Build shard-balanced log ID list** calls the script with `--format csv`; removed all `vars.CANOPY_PERF_*LPS_*` job `env` entries.
- Docs: [plan-0009](plan-0009-bootstrap-and-load-test-readiness.md), `perf/k6/canopy-api/README.md`, `docs/workers-environments.md`.
- `perf/package.json`: script **`generate-shard-balanced-ids`**.

## Risks and notes

- **Randomness**: new UUIDs every run mean grant-pool and k6 target different logs each time; that is usually desirable for load tests and avoids stale state. If you ever need **repeatable** runs, add an optional `--seed` later (out of scope unless requested).
- **API cost**: more logs ⇒ more bootstrap/register/poll cycles in **Generate grant pool**; count is already bounded (4, 8, or 12).
- **Doppler / GitHub**: remove any synced `CANOPY_PERF_*LPS_*` keys from templates so they are not recreated unnecessarily.

## Verification

- Manual: `workflow_dispatch` perf with each `logs_per_shard`; confirm grant pool step logs the expected count and k6 runs.
- Assert shard distribution: optional step can log `logId -> shard` (workflow already has djb2 diagnostic block reading `/tmp/log_ids.txt`).

## Completion

Workflow no longer references `CANOPY_PERF_*LPS_*` GitHub variables; validate with a manual **Performance Tests** run on **dev** / **stage** / **prod**.
