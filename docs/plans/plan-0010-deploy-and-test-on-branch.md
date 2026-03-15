# Deploy and test your branch (Plan 0010)

**Status:** DRAFT  
**Date:** 2026-03-14  
**Related:** [Plan 0010 grant workflow](plan-0010-grant-workflow-and-taskfiles.md)

This doc explains the GitHub Actions that affect deployment and how to get a **fully deployed stack for your branch** (so you can run e2e and smoke against it).

---

## 1. Workflow summary

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| **Tests** | Push/PR to `main` | Lint, unit tests, perf lib tests, e2e **local** (no deploy). |
| **Deploy Workers** | **Push to `main`** (path-filtered) **or** **workflow_dispatch** | Deploys canopy-api, delegation-signer, forestrie-ingress, x402-settlement to Cloudflare (dev or prod). On success, runs **Smoke test**. |
| **Smoke Test** | Called by Deploy Workers, or **workflow_dispatch** | Runs `task scrapi:smoke:N` against an environment (dev/prod). Uses `ENV` and dotenv (`.env`, `.env.{{ENV}}`) for `SCRAPI_BASE_URL` and `SCRAPI_API_KEY`. |
| **Cloudflare Infrastructure** | **workflow_dispatch** only | Creates/destroys Cloudflare infra (R2, queues, etc.) via `task cf:bootstrap`. |
| **Release** | Push of tag `v*` | Deploys to **production** (with approval), then smoke. |
| **Performance Tests** | **workflow_dispatch** only | Runs k6 against dev/prod using `perf/.env.dev` or `perf/.env.prod`; generates grant pool then load test. |

Important: **automatic deploy runs only on push to `main`**. Your branch is not deployed unless you run **Deploy Workers** manually and select your branch.

---

## 2. What you need for a fully deployed stack on your branch

### 2.1 One-time (per environment): Cloudflare infrastructure

If the dev environment does not already have the required buckets and queues:

1. **Actions** → **Cloudflare Infrastructure** → **Run workflow**.
2. **Branch:** any (workflow only needs taskfile and scripts).
3. **Use workflow from:** Branch: `main` (or the branch that has the taskfile you use).
4. Inputs:
   - **action:** `apply`
   - **canopy_id:** e.g. `canopy-dev-1`
   - **forest_project_id:** e.g. `forest-dev-1`
5. **Secrets:** `CLOUDFLARE_API_TOKEN` (and for R2 CORS step, `R2_ADMIN`) must be set in the repo.
6. Run. This creates R2 buckets, queues, etc. You typically do this once per environment.

(To create the **grants** bucket used by canopy-api, ensure the bootstrap task includes it; see `taskfiles/cloudflare.yml` and canopy-api’s `R2_GRANTS` binding.)

### 2.2 Deploy your branch to dev

1. **Push your branch** (e.g. `robin/log-bootstrapping-subplan-08`) to the remote.
2. **Actions** → **Deploy Workers** → **Run workflow**.
3. **Use workflow from:** Branch: **your branch** (e.g. `robin/log-bootstrapping-subplan-08`).
4. Inputs:
   - **environment:** `dev`
   - **app:** leave empty to deploy all four workers, or choose one (e.g. `canopy-api`).
5. **Secrets:** `CLOUDFLARE_API_TOKEN` is required. For **canopy-api** in **prod**, `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` are used if set.
6. Run.

The workflow will:

- Check out **your branch**.
- Run unit tests for each app that is being deployed.
- Run `task wrangler:deploy:<app> ENV=dev` (or prod) for each selected app.
- On success, call **Smoke test** with `environment: dev`.

So after this, the **dev** stack in Cloudflare is running the code from your branch. The smoke test runs against the URL configured for dev (see below).

### 2.3 Smoke test and env config

Smoke test is invoked by Deploy Workers with `environment: dev` (or prod). It runs:

```bash
ENV=dev task scrapi:smoke:3
```

`task` loads dotenv from `.env` and `.env.{{ENV}}` (e.g. `.env.dev`). So for smoke to hit your deployed dev API:

- **`.env.dev`** (committed) must set:
  - `SCRAPI_BASE_URL` – base URL for the dev canopy-api (e.g. `https://api-dev.forestrie.dev/logs/<logId>` or your dev worker URL).
  - `SCRAPI_API_KEY` – API key the dev deployment accepts.

If your dev deployment uses a different URL (e.g. a Workers subdomain), either:

- Update `.env.dev` in your branch so `SCRAPI_BASE_URL` points at that deployment, and push, then re-run Deploy Workers from that branch so smoke uses the new URL; or  
- Run smoke manually from your machine with the right env (e.g. `SCRAPI_BASE_URL=... SCRAPI_API_KEY=... ENV=dev task scrapi:smoke:3`).

### 2.4 Running e2e against your deployed branch

After deploying your branch to dev:

1. Get the dev canopy-api base URL (e.g. from `.env.dev` or your Workers dashboard).
2. Run e2e with **remote** project and that URL:

   ```bash
   CANOPY_E2E_BASE_URL=https://<your-dev-canopy-api-url> pnpm run test:e2e:remote
   ```

   Or run only the grant-flow test:

   ```bash
   cd packages/tests/canopy-api && CANOPY_E2E_BASE_URL=https://<your-dev-canopy-api-url> pnpm exec playwright test --project=remote -g "grant flow"
   ```

For the **grant flow** e2e to pass (not skip), the dev deployment must have:

- **Delegation-signer** configured (`DELEGATION_SIGNER_URL`, `DELEGATION_SIGNER_BEARER_TOKEN`, and for bootstrap branch `ROOT_LOG_ID`; optionally `UNIVOCITY_SERVICE_URL`).
- **Grant sequencing** (queue/DO) configured so register returns 303.
- A **queue consumer** (e.g. ranger in arbor) running so the status URL eventually returns a receipt; otherwise the test will skip with “Poll timeout”.

---

## 3. Checklist for “fully deployed stack for my branch”

- [ ] **Infrastructure:** Cloudflare Infrastructure workflow has been run with `apply` for the dev environment (or you know it’s already there).
- [ ] **Secrets:** Repo has `CLOUDFLARE_API_TOKEN`; for prod canopy-api, `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` if you use CDP.
- [ ] **Branch pushed:** Your branch is pushed to the remote.
- [ ] **Deploy Workers:** Run **Deploy Workers** manually, select **your branch**, environment **dev**, and (if you want) all apps or only the ones you changed.
- [ ] **Smoke:** After deploy, the Smoke test job runs automatically; it uses `.env.dev` (from the branch you deployed). If smoke fails, check `SCRAPI_BASE_URL` and `SCRAPI_API_KEY` in `.env.dev` and that the deployed workers are healthy.
- [ ] **E2E (optional):** Run e2e remote with `CANOPY_E2E_BASE_URL` set to your dev canopy-api URL; for grant flow, ensure delegation-signer and queue (and consumer) are configured in that environment.

---

## 4. Branch vs main

- **Push to `main`** (with path changes under the filtered paths) triggers **Deploy Workers** automatically for **dev** and then smoke. So “main” is the only branch that auto-deploys.
- **Any other branch** (e.g. a feature branch) is deployed only if you run **Deploy Workers** via **workflow_dispatch** and choose that branch. There is no separate “preview” or “branch” environment in these workflows; you deploy into the same **dev** (or prod) environment, so deploying your branch to dev temporarily replaces what’s on dev with your branch’s code until the next deploy.
