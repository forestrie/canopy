# Worker environments (canopy-api)

## Worker names and routes

| Wrangler config        | Worker name in dashboard | Route                                      | When it gets deployed                                                                       |
| ---------------------- | ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Top-level (no `--env`) | **canopy-api**           | No route in wrangler (may use workers.dev) | Only when someone runs `wrangler deploy` without `ENV` from the app directory               |
| `--env dev`            | **canopy-api-dev**       | `api-dev.forestrie.dev/*`                  | **Deploy Workers** workflow (push to main → dev, or workflow_dispatch with environment=dev) |
| `--env prod`           | **canopy-api-prod**      | `api.forestrie.dev/*`                      | **Deploy Workers** workflow_dispatch with environment=prod                                  |

All three configs include the **R2_GRANTS** binding (and R2_MMRS, DOs, etc.).

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

| Wrangler env | Worker name (dashboard) | Route(s) | Notes |
|--------------|-------------------------|----------|--------|
| **`dev`** | **forestrie-ingress-dev** | _(none — use `wrangler dev` locally)_ | Avoids overlapping zone routes with prod. |
| **`prod`** | **forestrie-ingress-prod** | `api.*.forestrie.dev/canopy/ingress-queue/*` | **Strategy B**: matches Terraform / Doppler **`RANGER_INGRESS_QUEUE_URL`** `https://api.<DNS_SUB>.forestrie.dev/canopy/ingress-queue` for hosts under zone **`forestrie.dev`**. |

Deploy **`prod`** after DNS for **`api.<DNS_SUB>.forestrie.dev`** exists (Terraform in **forest-1** publishes the hostname + URL to Doppler). Other apex domains require adjusting **`zone_name`** / **`pattern`** in [`packages/apps/forestrie-ingress/wrangler.jsonc`](../packages/apps/forestrie-ingress/wrangler.jsonc).
