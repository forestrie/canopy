# Worker environments (canopy-api)

## Worker names and routes

| Wrangler config        | Worker name in dashboard | Route                                      | When it gets deployed                                                                       |
| ---------------------- | ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Top-level (no `--env`) | **canopy-api**           | No route in wrangler (may use workers.dev) | Only when someone runs `wrangler deploy` without `ENV` from the app directory               |
| `--env dev`            | **canopy-api-dev**       | `api-dev.forestrie.dev/*`                  | **Deploy Workers** workflow (push to main → dev, or workflow_dispatch with environment=dev) |
| `--env prod`           | **canopy-api-prod**      | `api.forestrie.dev/*`                      | **Deploy Workers** workflow_dispatch with environment=prod                                  |

All three configs include the **R2_GRANTS** binding (and R2_MMRS, DOs, etc.).

## Promotion lanes vs shared edge ingress

Two ideas are easy to confuse:

| Idea | Meaning |
|------|---------|
| **Promotion lane** | **`dev`** → **canopy-api-dev** / `api-dev.forestrie.dev`; **`prod`** → **canopy-api-prod** / `api.forestrie.dev` |
| **Edge ingress deployment** | Cloudflare Worker **forestrie-ingress-prod** (Wrangler **`env.prod`** on the **forestrie-ingress** app) |

**Both API lanes** bind `SEQUENCING_QUEUE` to script **`forestrie-ingress-prod`**. That is
**shared** sequencing infrastructure at the edge, not “prod lane only.” The dev lane is
**not incomplete** — it has its own API Worker; it does **not** use **forestrie-ingress-dev**
in Cloudflare (**forestrie-ingress-dev** is local `wrangler dev` only).

Deployed **canopy-api-*** vars and bindings (including `R2_MMRS` bucket and ingress script
name) come from the GitHub Environment (**`dev`** / **`prod`**) and
`packages/apps/canopy-api/scripts/apply-runtime-contract.mjs` at deploy time — not from
`wrangler.jsonc` defaults alone.

Forest bootstrap publishes and verifies the contract per lane; see **forest-1**
`docs/bootstrap-canopy-contract.md`. Future per-project ingress isolation:
`docs/arc-0001-per-project-ingress-isolation.md`.

## Perf test and dev traffic

- The **Performance Tests** workflow uses GitHub Environment **`dev`**, **`stage`**, or **`prod`** (Doppler **`dev`** / **`stg`** / **`prd`** sync). Variables and secrets supply **`CANOPY_BASE_URL`**, **`FORESTRIE_INGRESS_URL`**, **`SCRAPI_API_KEY`**, etc. **Perf log IDs are not stored in GitHub**—each run generates shard-balanced UUIDs with `perf/scripts/generate-shard-balanced-ids.js` (no Doppler CLI or `.env` file in the job).
- That hostname is routed to **canopy-api-dev**, not to the worker named **canopy-api**.
- So perf and normal dev traffic hit **canopy-api-dev**.

## Deploying a feature branch to dev

**Deploy Workers** runs on **push to main** only (for automatic deploys). To get a feature branch (e.g. `robin/register-grant-phase-1`) onto dev:

1. In GitHub Actions, open **Deploy Workers**.
2. Click **Run workflow**.
3. Choose **Branch: robin/register-grant-phase-1** (or your branch) in the dropdown.
4. Set **Deployment environment** to **dev**.
5. Run the workflow.

That deploys **canopy-api-dev** from your branch so that api-dev.forestrie.dev and the perf test use the branch code.

If you deploy from the repo root with `task wrangler:deploy:canopy-api` **without** `ENV=dev`, you deploy the **canopy-api** (default) worker, which is **not** the one serving api-dev.forestrie.dev.

## forestrie-ingress (ledger HTTP queue API)

| Wrangler env | Worker name (dashboard)    | Route(s)                                 | Notes                                                                                                                                                                                                                                                                             |
| ------------ | -------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`dev`**    | **forestrie-ingress-dev**  | _(none — use `wrangler dev` locally)_    | Avoids overlapping zone routes with prod.                                                                                                                                                                                                                                         |
| **`prod`**   | **forestrie-ingress-prod** | `*.forestrie.dev/canopy/ingress-queue/*` | **Strategy B** shared **edge ingress** (not “prod promotion lane only”). Covers **`RANGER_INGRESS_QUEUE_URL`** `https://api-<DNS_SUB>.forestrie.dev/canopy/ingress-queue`. |

Deploy **`prod`** after DNS for **`api-<DNS_SUB>.forestrie.dev`** exists (Terraform in **forest-1** publishes the hostname + URL to Doppler). Other apex domains require adjusting **`zone_name`** / **`pattern`** in [`packages/apps/forestrie-ingress/wrangler.jsonc`](../packages/apps/forestrie-ingress/wrangler.jsonc).

## delegation-coordinator (Phase 3 management + issuance material store)

| Wrangler env | Worker name (dashboard)           | Route(s)                              | Notes |
| ------------ | ------------------------------- | ------------------------------------- | ----- |
| **`dev`**    | **delegation-coordinator-dev**  | `coordinator-dev.forestrie.dev/*`     | Sharded `DelegationStoreDO` (`shard-0` … `shard-{N-1}`). Local `wrangler dev` on port **8793**. |
| **`prod`**   | **delegation-coordinator-prod** | `coordinator.forestrie.dev/*`         | Same shard model; `CUSTODIAN_URL` must match the active ledger slot. |

Secrets (per env): **`COORDINATOR_APP_TOKEN`** (management APIs + issuance auth), **`CUSTODIAN_APP_TOKEN`** (custody-keys orchestration only — coordinator never calls Custodian sign).

Forest bootstrap publishes **`DELEGATION_COORDINATOR_URL`** into the Canopy consumer contract (`canopy-dev` / `canopy-prod` Doppler configs) and syncs it to GitHub Environment **`dev`** / **`prod`**. Custodian uses the same URL (arbor-flux `DELEGATION_COORDINATOR_URL`) to proxy wallet-managed logs and local-key misses.

**Ops runbook:** [plan-0022](plans/plan-0022-delegation-coordinator-ops-parity.md), [forest-1 bootstrap-canopy-contract](../../forest-1/docs/bootstrap-canopy-contract.md) (coordinator token + deploy tasks).
