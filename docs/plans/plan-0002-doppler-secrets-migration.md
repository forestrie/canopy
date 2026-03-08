# Plan 0002: Migrate Canopy secrets and variables to Doppler (sync + hybrid)

**Status**: DRAFT  
**Date**: 2026-03-07  
**Goal**: Use Doppler as the source of truth for Canopy secrets and variables via **two Doppler projects**: (1) **canopy-ci** — secrets needed directly by GitHub Actions, synced to the repo; (2) **canopy-cloudflare** — secrets and variables needed only by Cloudflare (e.g. Worker secrets), synced to Cloudflare via Doppler’s **Cloudflare native sync**. Any keys not in Doppler remain managed only in GitHub (hybrid).

---

## 1. Purpose and scope

- **In scope**: Repository secrets and variables in `forestrie/canopy` used by GitHub Actions workflows or by Cloudflare (Workers, etc.). The plan uses two Doppler projects:
  - **canopy-ci**: Secrets/variables that CI needs directly (workflows, Taskfiles in CI). Synced **Doppler → GitHub** via the Doppler GitHub App; workflows keep reading from GitHub.
  - **canopy-cloudflare**: Secrets/variables that only Cloudflare needs (e.g. Worker env/secrets). Synced **Doppler → Cloudflare** via Doppler’s Cloudflare integration; no need for workflows to push these to Cloudflare.
- **Out of scope**: Secrets/variables used only by other forestrie repos (e.g. forest-1, arbor-flux); those can be planned separately.
- **Deliverable**: Inventory, assignment of each key to canopy-ci vs canopy-cloudflare vs GitHub-only, and a phased migration plan including Cloudflare native sync setup.

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
| `CDP_API_KEY_ID` | 2026-01-22 | CDP (Cloudflare Developer Platform) API key ID; **pushed to Cloudflare** by `deploy-workers.yml` (`wrangler secret put` for canopy-api prod). Also used by taskfile `x402.yml` (faucet). → **canopy-cloudflare** (Cloudflare native sync). |
| `CDP_API_KEY_SECRET` | 2026-01-22 | CDP API key secret; same as above. → **canopy-cloudflare**. |
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

**Summary**: 8 repo secrets and 1 repo variable are in scope. **Split for two projects**: secrets needed only by Cloudflare (today: `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` — pushed to Workers by the workflow) → **canopy-cloudflare** with Cloudflare native sync; all others that CI uses directly → **canopy-ci** with GitHub sync. Local `.env.secrets` and Taskfile use can be documented for local dev (e.g. `doppler run` or download from canopy-ci/canopy-cloudflare as needed).

---

## 3. GitHub workflows

With **canopy-ci** syncing to GitHub, workflows continue to use `secrets.*` and `vars.*` for CI-needed keys; no change to how they read secrets. **One optional workflow change** after **canopy-cloudflare** is syncing to Cloudflare:

| Workflow file | Secrets / vars used today | Notes |
|---------------|----------------------------|--------|
| **.github/workflows/cloudflare-bootstrap.yml** | `secrets.CLOUDFLARE_API_TOKEN`, `secrets.R2_ADMIN` | Values from GitHub (synced from **canopy-ci**). No change. |
| **.github/workflows/deploy-workers.yml** | `secrets.CLOUDFLARE_API_TOKEN`, `secrets.CDP_API_KEY_ID`, `secrets.CDP_API_KEY_SECRET`, `secrets.GITHUB_TOKEN` | **After Cloudflare sync**: Remove `secrets.CDP_API_KEY_ID` and `secrets.CDP_API_KEY_SECRET` from job env and **remove the step** “Configure CDP secrets for canopy-api (prod)” (the one that runs `wrangler secret put CDP_API_KEY_*`). CDP secrets will already be in Cloudflare via Doppler → Cloudflare sync. GITHUB_TOKEN stays GitHub-provided. |
| **.github/workflows/perf-canopy.yml** | `secrets.CANOPY_PERF_API_TOKEN`, `secrets.CANOPY_X402_DEV_PRIVATE_KEY` | From GitHub (synced from **canopy-ci**). No change. |
| **.github/workflows/release.yaml** | `secrets.CLOUDFLARE_API_TOKEN`, `secrets.GITHUB_TOKEN` | From GitHub (canopy-ci). No change. |
| **.github/workflows/smoke-test.yml** | `secrets.GITHUB_TOKEN`; optionally `CLOUDFLARE_API_TOKEN` | No change. |
| **.github/workflows/test.yml** | None | Unchanged. |

**Note**: `GITHUB_TOKEN` is provided by GitHub. Keys in **canopy-ci** appear in the repo as secrets/variables via Doppler → GitHub sync. Keys in **canopy-cloudflare** are synced to Cloudflare only and are not needed in GitHub once the deploy-workers step above is removed.

---

## 4. Taskfiles (go-task)

In CI, workflows pass secrets into the job env (from GitHub, which is synced from Doppler for synced keys). Task invocations like `task wrangler:deploy:...` or `task scrapi:smoke:N` therefore see the same env as today; **no Taskfile code changes are required for CI**.

For **local dev**, Taskfiles load `.env`, `.env.{{.ENV}}`, and `.env.secrets`. Optional updates:

- **Option A**: Document that developers can run `doppler run -- task ...` so env is supplied by Doppler CLI (same key names). No change to Taskfile.dist.yml.
- **Option B**: Document a one-off or script that runs `doppler secrets download --no-file --format env > .env.secrets` so existing dotenv load order still works; secrets are then sourced from Doppler into the same file.

| Taskfile | Env / vars used | Notes |
|----------|-----------------|--------|
| **Taskfile.dist.yml** | `dotenv: [".env", ".env.{{.ENV}}", ".env.secrets"]`; vars and includes. | No change for CI. For local dev, optional: use `doppler run` or generate `.env.secrets` from Doppler. |
| **taskfiles/cloudflare.yml** | `CLOUDFLARE_API_TOKEN` (from .env/.env.secrets or job env in CI). | CI gets it from GitHub (synced). Local: `.env.secrets` or `doppler run`. |
| **taskfiles/scrapi.yml** | `API_KEY` (→ `SCRAPI_API_KEY`). | Same. |
| **taskfiles/perf.yml** | `CANOPY_PERF_API_TOKEN`. | Same. |
| **taskfiles/x402.yml** | `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`. | Same. |
| **taskfiles/minio.yml** | `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`. | Local-only; can stay in `.env` or in Doppler. |
| **taskfiles/wrangler.yml**, **deploy.yml**, **merklelog.yml**, **scout.yml** | Inherit env. | No change. |

**Summary**: No Taskfile edits required for the sync approach. Optionally document local dev (Doppler CLI or download-to-.env.secrets).

---

## 5. Doppler design: two projects (canopy-ci, canopy-cloudflare) + hybrid

**Approach**: Two Doppler projects with different sync targets.

| Doppler project | Purpose | Sync target | Used by |
|-----------------|---------|-------------|---------|
| **canopy-ci** | Secrets and variables needed **directly by GitHub Actions** (workflows, Taskfiles in CI). | **Doppler → GitHub** (Doppler GitHub App). | Workflows read from repo secrets/variables; no workflow code change except removing the CDP push step once Cloudflare sync is live. |
| **canopy-cloudflare** | Secrets and variables needed **only by Cloudflare** (e.g. Worker secrets, Worker env). | **Doppler → Cloudflare** (Doppler Cloudflare integration, native sync). | Cloudflare Workers/services; not needed in GitHub after the deploy-workers “Configure CDP secrets” step is removed. |

Any key not in either Doppler project remains **only in GitHub** (hybrid) and is managed in repo Settings.

### 5.1 canopy-ci (sync to GitHub)

- **Project name**: `canopy-ci`.
- **Config(s)**: e.g. one config `github` or `ci` that holds only the keys CI needs and that will be synced to the repo. Use the same key names as today so workflows keep working.
- **Keys to include**: Everything workflows or Taskfiles in CI use **except** those that are only consumed by Cloudflare:
  - `CLOUDFLARE_API_TOKEN`, `R2_ADMIN`, `CANOPY_PERF_API_TOKEN`, `CANOPY_X402_DEV_PRIVATE_KEY`, `GITAPP_PRIVATE_KEY`, `GITAPP_ID`; optionally `ANTHROPIC_API_KEY` and others from `.env.example.secrets` that CI needs.
  - **Do not** put `CDP_API_KEY_ID` or `CDP_API_KEY_SECRET` here; they belong in **canopy-cloudflare** and will be synced to Cloudflare only.
- **Sync**: Doppler GitHub App → Repository `forestrie/canopy` → Actions. Enable “Sync unmasked secrets as variables” for keys that should be GitHub variables (e.g. `GITAPP_ID`). Doppler will create some `DOPPLER_*` secrets in the repo; leave them.
- **Keys to leave only in GitHub**: Any secret/variable you do not add to the canopy-ci sync config stays in GitHub only.

### 5.2 canopy-cloudflare (Cloudflare native sync)

- **Project name**: `canopy-cloudflare`.
- **Config(s)**: e.g. `prod` (and optionally `dev`) with secrets/variables that only Cloudflare needs. At minimum: `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` (these are today pushed to the canopy-api Worker prod env by the workflow). Add any other Worker-only secrets from `.env.example.secrets` (e.g. `API_KEY_SECRET`, `R2_WRITER`, `R2_READER`) if they are bound to Workers and you want them managed in Doppler.
- **Sync**: Use Doppler’s **Cloudflare integration** (native sync). Connect the Cloudflare account, select the target (e.g. Workers project / script name and environment, such as canopy-api prod). Map the Doppler config to that Cloudflare target so that the config’s secrets are synced as Worker secrets (and/or env vars) in Cloudflare. After this is active, the workflow no longer needs to run `wrangler secret put` for these keys.
- **Naming**: Use the same key names in Doppler as expected by the Worker (e.g. `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`) so Cloudflare receives the correct names.

### 5.3 Summary: what goes where

| In **canopy-ci** (→ GitHub) | In **canopy-cloudflare** (→ Cloudflare) | Only in GitHub (not in Doppler) |
|-----------------------------|----------------------------------------|----------------------------------|
| `CLOUDFLARE_API_TOKEN`, `R2_ADMIN`, `CANOPY_PERF_API_TOKEN`, `CANOPY_X402_DEV_PRIVATE_KEY`, `GITAPP_ID`, `GITAPP_PRIVATE_KEY`, optionally `ANTHROPIC_API_KEY`. | `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`; optionally other Worker-only secrets. | Any key you choose not to put in Doppler. |
| Workflows read from GitHub. | Workers read from Cloudflare; no CI push step. | Workflows keep using them. |

### 5.4 Caveats

- **canopy-ci**: Deleting a secret in the synced config removes it from GitHub. For keys that should be GitHub **variables**, set unmasked in Doppler and enable “Sync unmasked secrets as variables.” If you use GitHub Environments (e.g. `prod`), you can add a second sync from another canopy-ci config to that environment.
- **canopy-cloudflare**: Deleting a secret in the synced config removes it from Cloudflare. Ensure the Doppler → Cloudflare mapping (project/script/env) matches your Wrangler setup (e.g. canopy-api, env prod) so Worker secrets have the correct names and visibility.
- **Local dev**: Taskfile `x402.yml` uses `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` (faucet). For local runs, developers can use `doppler run` with the **canopy-cloudflare** project/config, or keep these in `.env.secrets` if not using Doppler locally for Cloudflare-only keys.

### 5.5 Local dev (optional)

- **CI-needed keys**: Document `doppler run --project canopy-ci -- task ...` or download from canopy-ci to `.env.secrets`.
- **Cloudflare-only keys** (e.g. CDP for x402 faucet): Document `doppler run --project canopy-cloudflare -- task ...` for tasks that need them, or keep in `.env.secrets`.

---

## 6. Phased migration tasks (two projects)

### Phase 1: Create both Doppler projects and assign keys

1. Create Doppler project **canopy-ci** and a config (e.g. `github` or `ci`). Add secrets/variables needed by GitHub Actions only: `CLOUDFLARE_API_TOKEN`, `R2_ADMIN`, `CANOPY_PERF_API_TOKEN`, `CANOPY_X402_DEV_PRIVATE_KEY`, `GITAPP_PRIVATE_KEY`, `GITAPP_ID`, and optionally `ANTHROPIC_API_KEY`. Set unmasked for any that should sync as GitHub variables (e.g. `GITAPP_ID`). Do not add `CDP_API_KEY_ID` or `CDP_API_KEY_SECRET`.
2. Create Doppler project **canopy-cloudflare** and a config (e.g. `prod`, and optionally `dev`). Add secrets needed only by Cloudflare: `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`; optionally other Worker-only keys from `.env.example.secrets`. Use the same names as the Worker expects.
3. Document the mapping: which keys are in canopy-ci (→ GitHub), which in canopy-cloudflare (→ Cloudflare), and which remain only in GitHub.

### Phase 2a: canopy-ci → GitHub sync

4. Install the [Doppler GitHub App](https://github.com/apps/doppler-secretops-platform) and authorize it for `forestrie/canopy` (or the org). Grant it access to the canopy repository.
5. In Doppler (canopy-ci project): Integrations → GitHub → create integration: Repository sync target, `forestrie/canopy`, Actions feature, select the canopy-ci config. Enable “Sync unmasked secrets as variables” if you want `GITAPP_ID` (or others) as variables.
6. Verify: after “Set Up Integration”, the synced keys appear in the repo’s Settings → Secrets and variables → Actions. Optionally trigger a workflow run to confirm values are present and correct.
### Phase 2b: canopy-cloudflare → Cloudflare native sync

7. In Doppler (canopy-cloudflare project): set up the **Cloudflare integration** (native sync). Connect the Cloudflare account used for Canopy, and select the target: Workers script and environment that should receive the secrets (e.g. canopy-api, environment prod). Map the Doppler config (e.g. `prod`) to that target so that its secrets are synced as Worker secrets (and/or env vars) in Cloudflare.
8. Verify: after sync, the Cloudflare Worker (e.g. canopy-api prod) has `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` (and any other synced keys) available. Confirm via Cloudflare dashboard or a safe runtime check.

### Phase 3: Optional workflow change and local dev docs

9. **Optional workflow change**: In `.github/workflows/deploy-workers.yml`, remove the step "Configure CDP secrets for canopy-api (prod)" and remove `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` from the deploy job's `env`. CDP secrets are now in Cloudflare via Doppler → Cloudflare sync.
10. Update `README.md` or `docs/` with: (a) two projects — canopy-ci (→ GitHub) and canopy-cloudflare (→ Cloudflare), (b) which keys live in which project, (c) optional local dev: `doppler run --project canopy-ci -- task ...` and/or `doppler run --project canopy-cloudflare -- task ...` (e.g. for x402 faucet), or download to `.env.secrets` per project as needed.

### Phase 4: Cutover and cleanup

11. Run all relevant workflows (cloudflare-bootstrap, deploy-workers, perf-canopy, release, smoke-test) and confirm they succeed. Deploy canopy-api to prod and confirm the Worker has CDP secrets from Cloudflare (not from the removed step).
12. Remove from GitHub any keys that are now synced from canopy-ci, if they were duplicated during testing. Keep keys that remain only in GitHub. Do not remove CDP_* from GitHub until the deploy-workers change (step 9) is in place and verified.
13. Add a short doc listing which secrets/variables are in canopy-ci vs canopy-cloudflare vs only in GitHub, so contributors know where to request access or add values.

---

## 7. Files to touch (summary)

| Area | Files | Change |
|------|--------|--------|
| **Workflows** | `.github/workflows/deploy-workers.yml` | Optional: remove the "Configure CDP secrets for canopy-api (prod)" step and remove `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` from job `env` once Cloudflare sync is active. All other workflows unchanged; they keep using `secrets.*` / `vars.*` from GitHub (canopy-ci). |
| **Taskfiles** | None | No code changes for CI; optional local dev docs only. |
| **Docs** | `README.md` or `docs/` | Optional: document canopy-ci vs canopy-cloudflare, which keys live where, and local dev (`doppler run --project canopy-ci` / `canopy-cloudflare`, or download to `.env.secrets`). |

---

## 8. Risks and mitigations

- **Doppler outage**: If Doppler is down, sync may not run; existing GitHub secrets/variables already synced remain in the repo until the next sync. CI keeps working from GitHub. Mitigation: accept Doppler SLA; document that new/updated secrets are pushed on change and that GitHub holds the last synced values.
- **Accidental removal in Doppler**: Deleting a secret in a synced config removes it from the target (GitHub or Cloudflare) and can break CI or Workers. Mitigation: control who can edit canopy-ci and canopy-cloudflare configs; document the caveat in §5.4; for keys you want to stop syncing, add the value in the target first, then remove from Doppler.
- **Local dev**: Developers who need secrets locally can use Doppler CLI (`doppler run`) or download to `.env.secrets`; no Doppler CLI is required if they only run CI. Mitigation: clear docs and optional download flow.

---

## 9. Success criteria

- **canopy-ci** and **canopy-cloudflare** Doppler projects exist; keys are assigned to each and documented (hybrid split for any keys that stay only in GitHub).
- Doppler GitHub App is installed and sync is configured for canopy-ci to `forestrie/canopy` (Repository → Actions). Synced keys appear in the repo’s Secrets (and Variables if configured).
- Doppler Cloudflare integration is set up for canopy-cloudflare to Cloudflare (Workers script/env). CDP and other Cloudflare-only secrets are synced to Cloudflare; optionally the deploy-workers "Configure CDP secrets" step is removed.
- All workflows that use secrets run successfully. Workflows read CI-needed secrets from GitHub (canopy-ci); Workers read Cloudflare-needed secrets from Cloudflare (canopy-cloudflare).
- Keys not in either Doppler project remain in GitHub only and continue to work.
- Optional: local dev is documented (e.g. `doppler run --project canopy-ci` / `canopy-cloudflare`, or download to `.env.secrets`).
