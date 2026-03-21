# End-to-end (Playwright) test setup

E2e tests live in **`packages/tests/canopy-api`** (`@canopy/api-e2e`). The root Taskfile exposes:

| Task | Purpose |
|------|---------|
| **`task test:e2e:preflight`** | Tooling: `pnpm install`, Playwright CLI, Chromium (`e2e-shared:preflight` → `preflight:deps`). |
| **`task test:e2e:preflight:verify:local`** | After the **local** stack is listening: Node probes canopy **`/api/health`**, delegation-signer, univocity stub **`…/config` → 404**, **`POST /api/grants/bootstrap` → 201**. |
| **`task test:e2e:preflight:verify:remote`** | **`CANOPY_E2E_BASE_URL`** required; probes remote health + bootstrap mint **201**. |
| **`task test:e2e:preflight:infra`** | Legacy optional **`curl`** to delegation-signer when **`E2E_DELEGATION_SIGNER_HEALTH_URL`** is set. |
| **`task test:e2e`** | All Playwright projects from `playwright.config.ts` (default **`local`** + **`remote`**). |

Run these from the **repository root** (where `Taskfile.dist.yml` lives).

## Always required

- **Node** ≥ 20, **pnpm** ≥ 8 (see `task tools:check`).
- **`pnpm install`** at repo root (included in preflight).

## Local project — default “full stack”

- **URL:** `http://127.0.0.1:<port>` (default **8789**, or `CANOPY_E2E_LOCAL_PORT`).
- **Web server:** Playwright starts **`scripts/start-e2e-local-stack.mjs`**, which brings up:
  1. **`scripts/e2e-univocity-stub.mjs`** on **8792** (`UNIVOCITY_SERVICE_URL` for bootstrap branch),
  2. **delegation-signer** on **8791**,
  3. **canopy-api** with **`DELEGATION_SIGNER_*`**, **`ROOT_LOG_ID`**, **`UNIVOCITY_SERVICE_URL`**.
- **`CANOPY_E2E_LIGHT_STACK=true`:** use only **`pnpm --filter @canopy/api dev`** (fast iteration). Bootstrap / register tests **skip** or **soft-fail** paths as for partial infra; not CI-shaped.
- **Verify while stack runs:** in another terminal, `task test:e2e:preflight:verify:local` (URLs overridable via **`E2E_CANOPY_BASE_URL`**, **`E2E_DELEGATION_SIGNER_URL`**, **`E2E_UNIVOCITY_STUB_URL`**).

### What full local stack does *not* guarantee

- **Queue consumer / ranger:** grant **poll** may still time out if nothing drains **`SEQUENCING_QUEUE`**. The **grants** flow test may **skip** after poll timeout; fixing that means running the consumer (or a deployed pipeline) and is documented here so expectations stay honest.
- **Sequencing Durable Object in `wrangler dev`:** Cloudflare may reject cross-session DO RPC (e.g. “resolveContent … not yet supported between multiple dev sessions”). After bootstrap signature verification succeeds, **register-grant** then returns **503** with the real error instead of a misleading **403**. The **grants** flow test **skips** when register returns **503**; getting **303** locally usually requires a single dev session (e.g. **forestrie-ingress** linked) or deployed infra.
- **Remote Durable Objects:** `wrangler dev` may still hit **500**s on other DO paths.

### Manual stack (no Playwright)

```bash
node scripts/start-e2e-local-stack.mjs
# optional second terminal:
task test:e2e:preflight:verify:local
```

Copy **`packages/apps/delegation-signer/.dev.vars.example`** → **`.dev.vars`** if missing (the stack script does this automatically).

## Remote project

- **URL:** **`CANOPY_E2E_BASE_URL`** if set, otherwise the default in `playwright.config.ts`.
- **No** local web server when only **`remote`** is selected (see **`CANOPY_E2E_DISABLE_WEBSERVER`** in the package README).
- Run **`task test:e2e:preflight:verify:remote`** before **`playwright test --project=remote`** to fail fast if health or bootstrap mint is missing.

### Enabling skipped remote tests

| Gap | What to add |
|-----|-------------|
| **Playwright / Chromium** | `task test:e2e:preflight` |
| **Bootstrap mint** | Worker route **`POST /api/grants/bootstrap`**, **`DELEGATION_SIGNER_*`**, **`ROOT_LOG_ID`** as needed |
| **Register + poll + entry** | **`SEQUENCING_QUEUE`**, consumer, **`UNIVOCITY_SERVICE_URL`** (or equivalent) for first grant on an uninitialized log |

## Optional

- **`CANOPY_E2E_API_TOKEN`:** default **`test-api`**; used when endpoints require Bearer (most bootstrap tests use **`unauthorizedRequest`**).
- **`CANOPY_E2E_DISABLE_WEBSERVER`:** remote-only runs without starting local **`webServer`**.

## Package scripts (equivalent)

```bash
pnpm --filter @canopy/api-e2e test:e2e          # remote project only
pnpm --filter @canopy/api-e2e test:e2e:local    # local project only
pnpm --filter @canopy/api-e2e exec playwright test   # all projects (same as task test:e2e)
```
