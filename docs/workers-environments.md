# Worker environments (canopy-api)

## Worker names and routes

| Wrangler config | Worker name in dashboard | Route | When it gets deployed |
|-----------------|---------------------------|-------|------------------------|
| Top-level (no `--env`) | **canopy-api** | No route in wrangler (may use workers.dev) | Only when someone runs `wrangler deploy` without `ENV` from the app directory |
| `--env dev` | **canopy-api-dev** | `api-dev.forestrie.dev/*` | **Deploy Workers** workflow (push to main → dev, or workflow_dispatch with environment=dev) |
| `--env prod` | **canopy-api-prod** | `api.forestrie.dev/*` | **Deploy Workers** workflow_dispatch with environment=prod |

All three configs include the **R2_GRANTS** binding (and R2_MMRS, DOs, etc.).

## Perf test and dev traffic

- The **Performance Tests** workflow uses `perf/.env.dev` and sends traffic to **CANOPY_PERF_BASE_URL** (typically `https://api-dev.forestrie.dev`).
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
