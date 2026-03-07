# Plan 0002: Migrate Canopy secrets and variables to Doppler

**Status**: DRAFT  
**Date**: 2026-03-07  
**Goal**: Move GitHub Actions secrets and repository variables for the Canopy project to Doppler as the source of truth, and update workflows and local Taskfiles to consume from Doppler where appropriate.

---

## 1. Purpose and scope

- **In scope**: All repository **secrets** and **variables** currently stored in the `forestrie/canopy` GitHub repo that are used by GitHub Actions workflows or by go-task Taskfiles (including local development and CI).
- **Out of scope**: Secrets/variables used only by other forestrie repos (e.g. forest-1, arbor-flux); those can be planned separately.
- **Deliverable**: A clear inventory of what is in scope, which workflows and Taskfiles need changes, and a phased migration plan.

---

## 2. Current state (assessed via `gh` in canopy)

Assessment was done from the canopy repo with:

```bash
cd canopy && gh secret list && gh variable list
```

### 2.1 Repository secrets (in scope)

| Secret name | Last updated (from `gh`) | Purpose / used by |
|-------------|--------------------------|-------------------|
| `ANTHROPIC_API_KEY` | 2025-10-12 | Not referenced in workflows under `.github/workflows/`; likely agent/IDE or future use. Include in Doppler for consistency. |
| `CANOPY_PERF_API_TOKEN` | 2025-12-29 | Performance tests: auth for queue stats and API in `perf-canopy.yml` and taskfiles `perf.yml`. |
| `CANOPY_X402_DEV_PRIVATE_KEY` | 2026-02-04 | x402 dev wallet private key; used in `perf-canopy.yml` for reset-x402-auth and generate-x402-payment-pool. |
| `CDP_API_KEY_ID` | 2026-01-22 | CDP (Cloudflare Developer Platform) API key ID; used in `deploy-workers.yml` for configuring CDP secrets in Cloudflare (prod), and by taskfile `x402.yml` (faucet). |
| `CDP_API_KEY_SECRET` | 2026-01-22 | CDP API key secret; same as above. |
| `CLOUDFLARE_API_TOKEN` | 2025-10-13 | Wrangler/Cloudflare API auth; used in `deploy-workers.yml`, `release.yaml`, `cloudflare-bootstrap.yml`, and taskfile `cloudflare.yml` (validate, R2 CORS, status, destroy). |
| `GITAPP_PRIVATE_KEY` | 2025-11-26 | GitHub App private key (forestrie-cd-gitapp); not referenced in canopy workflows; may be used by other repos or future CI. Include in Doppler. |
| `R2_ADMIN` | 2025-11-29 | R2 admin token for direct R2 API (e.g. CORS config in `cloudflare-bootstrap.yml`). |

### 2.2 Repository variables (in scope)

| Variable name | Value (from `gh`) | Purpose / used by |
|---------------|--------------------|-------------------|
| `GITAPP_ID` | `2329547` | GitHub App ID; not referenced in canopy workflows; likely used by other repos or future CI. Include in Doppler. |

### 2.3 Local / file-based config (also in scope for Doppler)

- **Taskfile dotenv**: `Taskfile.dist.yml` loads `.env`, `.env.{{.ENV}}`, `.env.secrets` (in that order). These feed Taskfile vars and tasks (scrapi, cloudflare, perf, x402, etc.).
- **Example secrets**: `.env.example.secrets` documents expected keys: `R2_ADMIN`, `R2_WRITER`, `R2_READER`, `QUEUE_ADMIN`, `API_KEY_SECRET`, `SEQUENCER_*`, `MMR_SERVICE_*`. Not all of these are currently in GitHub (e.g. `R2_WRITER`/`R2_READER` may be in Cloudflare Workers only).
- **Perf env files**: `perf/.env.dev` and `perf/.env.prod` are committed and contain non-secret config (URLs, log IDs); perf workflow also sources these and uses `CANOPY_PERF_API_TOKEN` from GitHub Secrets. Doppler could eventually supply perf-related secrets only; config can stay in repo or move per team choice.

**Summary**: 8 repo secrets and 1 repo variable are in scope. Local `.env.secrets` and any equivalent env used by Taskfiles should be considered for sourcing from Doppler in local dev and/or CI.

---

## 3. GitHub workflows that need updates

Each workflow that today uses `secrets.*` or `vars.*` will need to be updated to obtain those values from Doppler (e.g. via Doppler GitHub Action or CLI) instead of, or in addition to, GitHub’s native secrets/variables.

| Workflow file | Secrets / vars used | Notes |
|---------------|--------------------|--------|
| **.github/workflows/cloudflare-bootstrap.yml** | `secrets.CLOUDFLARE_API_TOKEN`, `secrets.R2_ADMIN` | Apply, R2 CORS, status, destroy. |
| **.github/workflows/deploy-workers.yml** | `secrets.CLOUDFLARE_API_TOKEN`, `secrets.CDP_API_KEY_ID`, `secrets.CDP_API_KEY_SECRET`, `secrets.GITHUB_TOKEN` | Deploy job env; setup-task uses GITHUB_TOKEN (keep as-is). |
| **.github/workflows/perf-canopy.yml** | `secrets.CANOPY_PERF_API_TOKEN`, `secrets.CANOPY_X402_DEV_PRIVATE_KEY` | Job env and steps (reset-x402-auth, generate-x402-payment-pool). |
| **.github/workflows/release.yaml** | `secrets.CLOUDFLARE_API_TOKEN`, `secrets.GITHUB_TOKEN` | Deploy to prod; setup-task. |
| **.github/workflows/smoke-test.yml** | `secrets.GITHUB_TOKEN` (setup-task); optionally `CLOUDFLARE_API_TOKEN` when called with secrets | Smoke test runs `task scrapi:smoke:N`; may need SCRAPI/API auth from Doppler or injected env for CI. |
| **.github/workflows/test.yml** | None | No changes for Doppler. |

**Note**: `GITHUB_TOKEN` is provided by GitHub and should not be migrated to Doppler; workflows should continue to use it for Actions (e.g. setup-task).

**Suggested approach**: Introduce a single “Doppler fetch” step (or composite) that runs first and exports needed env (e.g. `CLOUDFLARE_API_TOKEN`, `R2_ADMIN`, `CDP_*`, `CANOPY_PERF_API_TOKEN`, `CANOPY_X402_DEV_PRIVATE_KEY`) so downstream steps and `task` invocations see the same variable names as today.

---

## 4. Taskfiles (go-task) that need updates

These Taskfiles rely on environment or vars that may come from `.env`/`.env.secrets` or from CI-injected env. After migration, local dev and CI should get secrets from Doppler (e.g. `doppler run -- task ...` or a wrapper that injects env).

| Taskfile | Env / vars used | Notes |
|----------|-----------------|--------|
| **Taskfile.dist.yml** | `dotenv: [".env", ".env.{{.ENV}}", ".env.secrets"]`; vars `CANOPY_ID`, `FOREST_PROJECT_ID`, `CLOUDFLARE_ACCOUNT_ID`; includes pass `SCRAPI_API_KEY`, `SCOUT_BASE_URL`, etc. | Root loader. Either (a) keep dotenv and add Doppler as an optional source (e.g. generate `.env.secrets` from Doppler), or (b) document “run under `doppler run`” and simplify dotenv to non-secret only. |
| **taskfiles/cloudflare.yml** | `CLOUDFLARE_API_TOKEN` (sourced from `.env`/`.env.secrets` in `queue:inspect:*` and validate). | Any task that calls Wrangler or Cloudflare API needs this; can be supplied by Doppler in CI and locally via `doppler run`. |
| **taskfiles/scrapi.yml** | `API_KEY` (from include vars → `SCRAPI_API_KEY`). | Used for Authorization header in smoke and API calls. Should be supplied from Doppler in CI if not from env. |
| **taskfiles/perf.yml** | `CANOPY_PERF_API_TOKEN` (defaults to `"test-api-key"` in some tasks). | Perf workflow already gets token from GitHub Secrets; switch to Doppler. Local perf can use `doppler run`. |
| **taskfiles/x402.yml** | `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` (documented in task desc). | Faucet/refill scripts; can read from env provided by Doppler. |
| **taskfiles/minio.yml** | `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` (R2-compat local dev). | Local-only; can remain in `.env` or move to Doppler for consistency. |
| **taskfiles/wrangler.yml** | Wrangler uses env (e.g. CLOUDFLARE_API_TOKEN) from shell. | No direct secret refs in file; inherits from root Taskfile and env. Ensure deploy jobs get Cloudflare token from Doppler. |
| **taskfiles/deploy.yml** | No direct secret refs. | Orchestrates wrangler deploys; env comes from root/caller. |
| **taskfiles/merklelog.yml**, **taskfiles/scout.yml** | Scout uses `SCOUT_BASE_URL`; merklelog may use shared env. | Document that any secret they need (e.g. API keys) will come from Doppler. |

**Summary**: The main touchpoints are (1) root `Taskfile.dist.yml` dotenv vs Doppler, (2) `cloudflare.yml` and `scrapi.yml` for Cloudflare and API auth, (3) `perf.yml` and `x402.yml` for perf and CDP/x402. All can be designed to receive the same env names from Doppler that they currently get from `.env.secrets` or GitHub Secrets.

---

## 5. Doppler-side design (recommendations)

- **Project**: One Doppler project for Canopy (e.g. `canopy`) with configs such as `dev` and `prod` to align with `ENV=dev` / `ENV=prod`.
- **Secrets/vars in Doppler**: Create Doppler secrets (or config-specific vars) for each of the 8 repo secrets and 1 repo variable listed in §2, using the same names (e.g. `CLOUDFLARE_API_TOKEN`, `R2_ADMIN`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CANOPY_PERF_API_TOKEN`, `CANOPY_X402_DEV_PRIVATE_KEY`, `GITAPP_ID`, `GITAPP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`). Add any additional keys from `.env.example.secrets` that should live in Doppler (e.g. `API_KEY_SECRET`, `QUEUE_ADMIN`, `R2_WRITER`, `R2_READER`) if they are used by Canopy.
- **Access**: Use Doppler’s GitHub Action (or CLI) with a single Doppler token stored as a **minimal GitHub secret** (e.g. `DOPPLER_TOKEN`) for CI; restrict token scope to the Canopy project/config(s). Local dev uses Doppler CLI and personal or service token.
- **Non-secret config**: Per-team choice: keep `perf/.env.dev` and `perf/.env.prod` in repo, or move non-secret values into Doppler as config vars.

---

## 5a. Alternative: Doppler sync to GitHub (no workflow changes)

Doppler’s **GitHub integration** can **push** secrets (and optionally variables) from a Doppler config into the repository. The Doppler GitHub App is installed on the org or repo and is given permission to manage repository secrets (and variables). Doppler then syncs one-way: **Doppler → GitHub**. Workflows keep using `secrets.*` and `vars.*` exactly as they do today; no workflow edits are required for synced keys.

### Is this feasible? Yes.

- **Sync behavior (from Doppler docs)**: When you set up a sync, Doppler syncs **all secrets in the chosen config** to the chosen GitHub target (repository or environment). When you **add, update, or remove** a secret in that Doppler config, the change is reflected in GitHub. Doppler does **not** import or read existing GitHub secret values (GitHub’s API does not expose them).
- **Important**: Sync is key-based. Doppler pushes only the keys that exist in the selected Doppler config. It does **not** delete GitHub secrets that are not present in Doppler. So:
  - **Secrets/variables that ARE in Doppler** → synced to GitHub (add/update); workflows keep using them via `secrets.*` / `vars.*`.
  - **Secrets/variables that are NOT in Doppler** → remain only in GitHub; you continue to manage them in the repo (Settings → Secrets and variables → Actions). Doppler never touches them.

So a **hybrid** setup is fully supported: put the subset you want in Doppler and sync that; leave the rest in GitHub. No workflow changes are needed; workflows continue to read from GitHub.

### Practical setup (sync path)

1. **Doppler**: Create a project (e.g. `canopy`) and a config (e.g. `github` or `ci`) that holds **only** the keys you want Doppler to own. Add those secrets (and any you want as variables) there. Do **not** add keys you want to keep only in GitHub.
2. **GitHub**: Install the [Doppler GitHub App](https://github.com/apps/doppler-secretops-platform) and authorize it for the `forestrie/canopy` repository (or org with access to canopy). During setup, choose “Repository” as sync target and select `forestrie/canopy`, and “Actions” as the feature.
3. **Sync**: In Doppler, create the GitHub integration: select the config to sync and the repo. Doppler will push that config’s secrets to the repo’s Actions secrets. Optionally enable “Sync unmasked secrets as variables” so unmasked Doppler entries become GitHub variables (e.g. for `GITAPP_ID`).
4. **Doppler-created secrets**: Doppler also creates a few `DOPPLER_*` secrets in the repo (e.g. for its own use). Leave them; they don’t affect your workflows unless you use them.
5. **Secrets not in Doppler**: Keep managing them in GitHub (Settings → Secrets and variables → Actions). They will not be overwritten or removed by sync.

### Hybrid: what to put where

| In Doppler (synced to GitHub) | Only in GitHub (not in Doppler) |
|------------------------------|----------------------------------|
| Keys you want to manage and audit in Doppler (e.g. `CLOUDFLARE_API_TOKEN`, `R2_ADMIN`, `CDP_*`, `CANOPY_PERF_API_TOKEN`, `CANOPY_X402_DEV_PRIVATE_KEY`, `GITAPP_ID` as variable, etc.). | Keys you don’t want in Doppler yet (e.g. `ANTHROPIC_API_KEY` if only used by IDE/agents), or one-off / legacy keys you’ll migrate later. |
| Use same names as today so workflows need zero changes. | Workflows already reference them; they keep working. |

### Caveats

- **Removal in Doppler**: If you **delete** a secret in the synced Doppler config, Doppler will remove it from GitHub. So don’t remove a key from Doppler if you still need it in GitHub; instead, add it to “only in GitHub” and remove it from the Doppler config only when you’re ready to stop syncing it (or leave it in Doppler).
- **Variables**: Use “Sync unmasked secrets as variables” if you want specific keys (e.g. `GITAPP_ID`) to appear as GitHub **variables**; in Doppler, set those to unmasked/visible so they sync as variables.
- **Environments**: If you use GitHub Environments (e.g. `prod` for release approval), you can create a second sync: a different Doppler config → GitHub Environment “prod”. That way repo-level and environment-level secrets can come from different Doppler configs.

### Summary

- **Feasible**: Yes. Install the Doppler app, permit it to push to the canopy repo, create a Doppler config with the subset of keys you want, and set up the sync. Workflows keep using `secrets.*` and `vars.*`; no changes needed.
- **Some secrets not in Doppler**: Fully supported. Those stay in GitHub only; Doppler does not delete or overwrite secrets it doesn’t know about. You can move them into Doppler later and add them to the synced config when ready.

---

## 6. Phased migration tasks

**Two paths**: If you use **Doppler sync** (§5a), Phase 2 (workflow edits) is unnecessary for synced keys—workflows keep reading from GitHub. Phases 1, 3, and 4 still apply (Doppler setup, Taskfiles/local dev, cutover). If you use the **fetch-in-CI** approach (no sync), follow all phases below.

### Phase 1: Doppler setup and inventory

1. Create Doppler project `canopy` (or org-equivalent) with configs `dev` and `prod`.
2. In Doppler, create secrets/vars for all 8 GitHub secrets and 1 GitHub variable, plus any from `.env.example.secrets` that are in scope (see §2 and §5). Do not delete GitHub secrets yet.
3. Document the mapping: GitHub secret/variable name → Doppler project/config and key name (same names recommended).
4. Add a single GitHub repo secret `DOPPLER_TOKEN` (or org-level secret) for the Canopy project, with minimal scope.

### Phase 2: GitHub Actions workflows

5. **cloudflare-bootstrap.yml**: Add a step to fetch required env from Doppler (e.g. `CLOUDFLARE_API_TOKEN`, `R2_ADMIN`) and export to `GITHUB_ENV`; remove or keep fallback to `secrets.*` during transition.
6. **deploy-workers.yml**: Add Doppler fetch step; provide `CLOUDFLARE_API_TOKEN`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` from Doppler to the deploy job.
7. **perf-canopy.yml**: Add Doppler fetch step; provide `CANOPY_PERF_API_TOKEN`, `CANOPY_X402_DEV_PRIVATE_KEY` from Doppler.
8. **release.yaml**: Add Doppler fetch step; provide `CLOUDFLARE_API_TOKEN` from Doppler for deploy-prod.
9. **smoke-test.yml**: If smoke tests need API/Cloudflare auth in CI, add Doppler fetch (or receive env from caller) and pass `SCRAPI_API_KEY` / `CLOUDFLARE_API_TOKEN` as needed so `task scrapi:smoke:N` has the same env as today.
10. Standardise on one pattern: e.g. “Doppler GitHub Action” or “doppler run” in a step that sets env for the rest of the job.

### Phase 3: Taskfiles and local dev

11. **Taskfile.dist.yml**: Document that secrets are provided by Doppler; either (a) add a task or doc step that runs `doppler run -- task ...` for local dev, or (b) generate `.env.secrets` from Doppler (e.g. `doppler secrets download --no-file --format env > .env.secrets`) and keep current dotenv load order.
12. **taskfiles/cloudflare.yml**, **scrapi.yml**, **perf.yml**, **x402.yml**: Ensure they use the same variable names as Doppler; no structural change if env is injected by Doppler (CI or `doppler run`).
13. Update `README.md` or `docs/` with: how to install Doppler CLI, how to run tasks with `doppler run`, and that GitHub Secrets are being replaced by Doppler for Canopy.

### Phase 4: Cutover and cleanup

14. Run each updated workflow (cloudflare-bootstrap, deploy-workers, perf-canopy, release, smoke-test) against Doppler-backed env and confirm success.
15. Remove or redact the 8 repository secrets and 1 variable from GitHub (or leave as redundant backup during a short parallel run). Prefer removing to avoid drift.
16. Optionally: add a small “secrets check” or doc that lists which values must exist in Doppler for Canopy (so new contributors know what to request).

---

## 7. Files to touch (summary)

| Area | Files |
|------|--------|
| **Workflows** | `.github/workflows/cloudflare-bootstrap.yml`, `.github/workflows/deploy-workers.yml`, `.github/workflows/perf-canopy.yml`, `.github/workflows/release.yaml`, `.github/workflows/smoke-test.yml` |
| **Taskfiles** | `Taskfile.dist.yml`, `taskfiles/cloudflare.yml`, `taskfiles/scrapi.yml`, `taskfiles/perf.yml`, `taskfiles/x402.yml` (and docs for wrangler, deploy, merklelog, scout, minio as needed) |
| **Docs** | `README.md` or `docs/` (Doppler setup, local dev, list of secrets in Doppler); `.env.example.secrets` can reference Doppler instead of manual paste. |

---

## 8. Risks and mitigations

- **Single point of failure**: Doppler outage could block CI. Mitigation: keep a short parallel run with GitHub Secrets if desired, or accept Doppler SLA and document runbook.
- **Token scope**: Ensure `DOPPLER_TOKEN` is restricted to the Canopy project/config so a leaked token does not expose other projects.
- **Local dev friction**: Developers must install Doppler CLI and have access to the Canopy project. Mitigation: clear docs and optional “download to .env.secrets” flow for those who cannot use Doppler CLI.

---

## 9. Success criteria

- All 8 GitHub repo secrets and 1 repo variable are represented in Doppler and used by the listed workflows.
- All 5 workflows that currently use secrets work using Doppler as the source (with or without a minimal `DOPPLER_TOKEN` in GitHub).
- Taskfiles that depend on those secrets work in CI when run inside a job that has fetched Doppler env, and local dev is documented (e.g. `doppler run -- task ...` or generated `.env.secrets`).
- GitHub repository secrets/variables for Canopy can be removed or deprecated without breaking CI or documented local flows.
