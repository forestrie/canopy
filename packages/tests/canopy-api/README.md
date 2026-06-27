# Canopy API End-to-End Tests

This package houses the Playwright API-mode tests for the Canopy Worker. It depends on `@canopy/api` but keeps the runtime isolated so Cloudflare build and deploy scripts remain unchanged.

Tests run against a **deployed** worker URL. They do **not** start wrangler or Custodian locally.

## Playwright projects and layout

Specs live under `tests/` in three tiers (each tier is a Playwright **project** with `testMatch` on that folder):

| Project         | Directory             | Role                                                                                                                                                                                  |
| --------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **integration** | `tests/integration/`  | Read-only / surface checks against **Canopy** only (CORS, health, SCRAPI discovery).                                                                                                  |
| **system**      | `tests/system/`       | Full deployed stack: SCRAPI grants, sequencing, receipts (needs **forestrie-ingress**, MMRS, Custodian mint env). **Flow docs:** [`tests/system/docs/`](tests/system/docs/README.md). |
| **custodian**   | `tests/custodian/`    | Direct **Custodian** HTTP (`/v1/api/…`), not the SCRAPI grant path.                                                                                                                   |
| **coordinator** | `tests/coordinator/`  | **delegation-coordinator** Phase 3 APIs + BYOK material path (`plan-0021`).                                                                                                           |
| **prod**        | (same files, filters) | Release checks: **excludes** mutating `tests/system/*` specs via `testIgnore` in `playwright.config.ts`.                                                                              |

Shared code: `tests/utils/`, `tests/fixtures/`. Imports use TypeScript path aliases (see `tsconfig.json`):

- `@e2e-utils/*` → `./tests/utils/*`
- `@e2e-fixtures/*` → `./tests/fixtures/*`
- `@e2e-canopy-api-src/*` → `../../apps/canopy-api/src/*` (only when not exported from `@canopy/api`)

## Prerequisites

From the **repo root** (recommended):

```bash
doppler run --project canopy --config dev -- task test:e2e:preflight
doppler run --project canopy --config dev -- task test:e2e
```

Bare **`task test:e2e`** runs preflight and self-wraps with Doppler when needed.

See **`taskfiles/e2e-setup.md`**.

## Scripts

- **Local (full dev suite):** `task test:e2e` — CI-parity sequence (integration → system → custodian → coordinator when configured). Use `ENV=prod` for prod Doppler config.
- **Local (explicit tier):** `doppler run --project canopy --config dev -- pnpm --filter @canopy/api-e2e test:e2e:system` (see **`.cursor/rules/e2e-local-doppler.mdc`**). Do **not** add `doppler run` to package.json scripts.
- **Single tier npm scripts:** `test:e2e:integration` | `test:e2e:system` | `test:e2e:custodian` | `test:e2e:coordinator` | `test:e2e:prod` (plain Playwright; wrap with Doppler locally).
- **CI:** workflows export env on the step; run `pnpm --filter @canopy/api-e2e exec playwright test` (see `.github/workflows/tests-system.yml` and `.github/workflows/tests-integration.yml`). Package **`pnpm test:e2e`** runs integration + system + custodian only (no coordinator) — use the Task entrypoint locally for full dev parity.

### Bootstrap grant (mint + register-grant)

`tests/system/grants-bootstrap.spec.ts` (and related bootstrap specs) exercise **ephemeral Imutable chain binding**: genesis **`POST /api/forest/{log-id}/genesis`** with real `(chain-id, univocity-addr)` from preflight, **contract-bootstrap-signed** root creation grant, and **`POST /register/{bootstrap-logid}/grants`** (303 See Other). Each spec runs for **ES256** and **KS256** via `describeForEachBootstrapVariant`.

Requires **`CANOPY_OPS_ADMIN_TOKEN`** (mint onboard tokens + genesis), Univocity provision env (see below), and for child/delegation specs **`CUSTODIAN_URL`** + **`CUSTODIAN_APP_TOKEN`**. The **deployed** worker needs **`R2_MMRS`**, sequencing queue bindings, and `bootstrapEnv` + `queueEnv`.

**First signed entry** (`tests/system/bootstrap-log-first-entry.spec.ts`): **ES256
and KS256** variants — `POST /register/{R}/entries` with contract-bootstrap
statement signing (ES256: 32-byte `kid` = x; KS256: 20-byte `kid` = address).

**Child auth grant** (`tests/system/bootstrap-child-auth-grant.spec.ts`): root contract-bootstrap mint; child envelope signed by **owner root key**; Custodian provisions child `grantData`.

### Non-Custodian log-root signing key (BYOK)

**Terminology:** the **log root key** that signs **delegation certificates** — not
the delegated checkpoint signer in `grantData`. Default `task test:e2e` includes
non-Custodian log-root signing when coordinator + ops admin env is set (Package D).

| Spec                                               | Project     | Default tier?                          | Role                                                                                             |
| -------------------------------------------------- | ----------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `coordinator/coordinator-byok-material.spec.ts`    | coordinator | Yes (when env set)                     | Runner-owned root; coordinator 503 pending → material → issue; `verifyByokDelegationCertificate` |
| `coordinator/coordinator-byok-public-root.spec.ts` | coordinator | Yes (when env set)                     | Upload root + GET CBOR `public-root`; cert verifies against rehydrated coordinator root          |
| `system/coordinator-delegation-issuance.spec.ts`   | system      | Yes (when coordinator + custodian set) | Same runner-signed material; **Custodian proxy** on KMS miss                                     |
| `system/byok-checkpoint-seal.spec.ts`              | system      | Yes (when coordinator + ops admin set) | Full SCRAPI checkpoint seal with wallet-signed material                                          |
| `system/byok-mode-c-webhook-seal.spec.ts`          | system      | Yes (when coordinator + ops admin set) | Mode C genesis webhook push + KS256 seal (FOR-126)                                               |

**Not BYOK:** `coordinator-api.spec.ts` (custodial pre-mint before wallet route);
all other `tests/system/*` (Custodian grant/statement keys).

**Not yet in e2e:** SCRAPI register-grant with non-Custodian grant signer
([arbor plan-0003](https://github.com/forestrie/arbor/blob/main/docs/plan-0003-non-custodial-checkpoint-support.md));
Sealer consuming coordinator `public-root` on deployed stack
([arbor plan-0005](https://github.com/forestrie/arbor/blob/main/docs/plan-0005-sealer-trust-root-end-to-end.md));
Canopy receipt verify BYOK in Playwright.

```bash
# Primary BYOK (coordinator tier, CI when env set)
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e test:e2e:coordinator

# System tier + Custodian proxy (default when env complete)
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
    tests/system/coordinator-delegation-issuance.spec.ts

# Mode C webhook push seal (cloudflared auto-tunnel when public base unset)
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
    tests/system/byok-mode-c-webhook-seal.spec.ts
```

Flow docs: [`tests/system/docs/README.md`](tests/system/docs/README.md).

## Environment variables

Resolved in **`playwright.config.ts`** from the **process environment** (Doppler-injected locally, GitHub Environment in CI). Locally, run via **`task test:e2e`** or **`doppler run --project canopy --config dev -- …`**.

**Worker origin** (one of):

- **`CANOPY_BASE_URL`** — full origin, e.g. Lane A `https://api-a-forest-2.forestrie.dev`, Lane B canonical `https://api-b-forest-2.forestrie.dev`, or prod alias `https://api-forest-2.forestrie.dev` (no trailing slash), or
- **`CANOPY_FQDN`** — host or URL; Playwright builds `https://{host}` the same way as `.github/workflows/tests-system.yml` (Doppler `dev` often supplies only `CANOPY_FQDN`).

**System / bootstrap e2e** (`tests/system/*.spec.ts`):

- **Runner:** **`CANOPY_OPS_ADMIN_TOKEN`** (mint onboard tokens; genesis via minted token), **`CUSTODIAN_URL`**, **`CUSTODIAN_APP_TOKEN`** (ensure custody key + sign). The **Worker** must expose SCRAPI **`/register/{bootstrap}/…`** with queue/MMRS configured.
- If bootstrap mint env is missing, tests **fail** immediately with a clear error.
- **`E2E_RUN_ID`**: written by `globalSetup` to `.e2e-run-id`; labels per-run custody keys for teardown.
- **`globalTeardown`**: best-effort delete of keys labeled `e2e-run-id` + `e2e-test-key` (needs **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`**). Set **`E2E_SKIP_CUSTODIAN_KEY_CLEANUP=1`** to skip. Static keys (`e2e-static-key: true`) are never auto-deleted.
- E2e helpers pass **`protectionLevel: "SOFTWARE"`** — do not use HSM keys in automated tests.

Other keys:

- **`SCRAPI_API_KEY`**: Bearer for authorized fixtures (optional for specs that use `unauthorizedRequest` only).

**Univocity ephemeral provision** (required for bootstrap **system** specs):

Provisioned in **`task test:e2e:preflight`** (default). Playwright sources **`.work/e2e-univocity.env`**:

- **`E2E_UNIVOCITY_ADDRESS_*_BOOTSTRAP`**, **`E2E_UNIVOCITY_GENESIS_LOG_ID_*`**
- **`E2E_UNIVOCITY_ES256_BOOTSTRAP_PEM_FILE`** — ES256 root grant + owner envelope signing
- **`E2E_UNIVOCITY_KS256_BOOTSTRAP_KEY_FILE`** — KS256 root grant + owner envelope signing
- **`E2E_UNIVOCITY_RPC_URL`**, **`E2E_UNIVOCITY_CHAIN_ID`** (optional defaults)
- **`E2E_UNIVOCITY_ES256_ALLOW_BOOTSTRAP`**, **`E2E_UNIVOCITY_KS256_ALLOW_BOOTSTRAP`** — when `false`, bootstrap mutating specs skip for that alg (CI when a supplied address is used instead of fresh provision)
- **`CANOPY_OPS_ADMIN_TOKEN`**: mint onboard tokens (`POST /api/payments/onboard-tokens`); genesis uses a minted token as `Bearer`

Opt out: **`SKIP_UNIVOCITY_PROVISION=true`** (bootstrap system specs skip per variant). See [plan-0032](../../docs/plans/plan-0032-univocity-imutable-e2e-provision.md).

**Delegation coordinator e2e** (`tests/coordinator/`, Playwright project **`coordinator`**):

- **`DELEGATION_COORDINATOR_URL`**, **`COORDINATOR_APP_TOKEN`**: coordinator management APIs and direct coordinator issue.
- **`CUSTODIAN_URL`**, **`CUSTODIAN_APP_TOKEN`**: required by `coordinator-api.spec.ts` for custodial pre-wallet mint and custody-keys orchestration.
- Deployed **Custodian** must have **`DELEGATION_COORDINATOR_URL`** configured for the stretch spec’s proxy path (ledger env; not a Playwright env var).
- CI runs this project after **custodian** when both coordinator env vars are set (`.github/workflows/tests-system.yml`); **`deploy-workers`** on **dev** requires coordinator e2e (fails if vars/secrets missing).
- Default **system** tier includes `coordinator-delegation-issuance`, `byok-checkpoint-seal`, and `byok-mode-c-webhook-seal` when env is complete (Package D / FOR-201).
- **`E2E_MODE_C_WEBHOOK_PUBLIC_BASE`**: optional manual public HTTPS base for webhook push; CI installs **cloudflared** for auto quick tunnel.
- **`E2E_MODE_C_ALLOW_PULL_FALLBACK=1`**: local debug only — pending-delegation pull when push fails (not CI).

**Hydrating coordinator secrets locally**

After forest bootstrap generates the token:

```bash
# forest-1 (once per lane)
CANOPY_PROMOTION_LANE=dev task bootstrap:canopy:bootstrap-coordinator-token:PROJECT_ID
CANOPY_PROMOTION_LANE=dev task bootstrap:canopy:sync-github-env:PROJECT_ID

# canopy repo root — coordinator vars must be in Doppler canopy/dev (or prod)
doppler run --project canopy --config dev -- pnpm --filter @canopy/api-e2e test:e2e:coordinator
```

Set **`COORDINATOR_APP_TOKEN`** in Doppler **`canopy/dev`** (masked) after forest bootstrap sync.

**Custodian API e2e** (`tests/custodian/custodian-api.spec.ts`, Playwright project **`custodian`**):

- **`CUSTODIAN_URL`**, **`CUSTODIAN_APP_TOKEN`**: ensure key, public, sign, curator, list via **`/v1/api/…`** (ingress); ops probes use the URL **origin** only (`/healthz`, `/readyz`, …).
- Uses a **static** log id (`E2E_STATIC_CUSTODIAN_API_LOG_ID` in `tests/utils/e2e-static-log-ids.ts`); no per-spec key delete.

**Listing all custody keys:** **`GET /api/keys/list`** requires at least one label query parameter. To list **every** key in the custody ring, use **`POST /api/keys/list`** with CBOR **`labels: {}`** (see `postCustodianApiKeysListAll` in `tests/utils/custodian-api-keys-list.ts`).

**Ops tasks (repo root):** `task custodian:keys-list` (needs **`CUSTODIAN_APP_TOKEN`** and **`CUSTODIAN_BASE_URL`** or default from `Taskfile.dist.yml`). `task custodian:keys-delete-all` lists keys then **dry-runs** deletes; set **`CONFIRM=1`** to call **`POST /v1/api/keys/{keyId}/delete`** per id (**`CUSTODIAN_BOOTSTRAP_APP_TOKEN`** required). `task custodian:keys-delete-by-label` with **`LABEL_KEY`** + **`LABEL_VALUE`** (e.g. `e2e-run-id` + run uuid). Prefer **`doppler run -- …`** when injecting tokens locally.

## Test layout (by file)

| File                                             | Area                                                                                                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration/api.spec.ts`                        | Cross-cutting HTTP (e.g. CORS OPTIONS).                                                                                                                                |
| `integration/observability.spec.ts`              | `/api/health`, `/.well-known/scitt-configuration`.                                                                                                                     |
| `system/grants-bootstrap.spec.ts`                | Ephemeral Imutable bootstrap: genesis + contract-signed root grant + register-grant (ES256 + KS256). [Doc](tests/system/docs/grants-bootstrap.md).                     |
| `system/forest-genesis-registration.spec.ts`     | Onboard-token mint + payment-authoritative genesis; `GF_DERIVED` endorsement descendant registration (ES256). Mutating — ignored on prod project.                      |
| `system/bootstrap-log-first-entry.spec.ts`       | `POST /register/{bootstrap}/entries` (ES256 + KS256). [Doc](tests/system/docs/bootstrap-log-first-entry.md).                                                           |
| `system/bootstrap-child-auth-grant.spec.ts`      | Root contract bootstrap + child auth grant (owner-root envelope); ES256 + KS256. [Doc](tests/system/docs/bootstrap-child-auth-grant.md).                               |
| `system/auth-data-log-chain.spec.ts`             | Root → child auth log → data log delegation chain; ES256 + KS256. [Doc](tests/system/docs/auth-data-log-chain.md).                                                     |
| `custodian/custodian-api.spec.ts`                | Direct **`fetch`** to deployed Custodian: ops + **`/v1/api/…`** custody key routes.                                                                                    |
| `coordinator/coordinator-api.spec.ts`            | Phase 3 coordinator APIs; **coordinator** direct issue of stored material (custodial pre-mint).                                                                        |
| `coordinator/coordinator-byok-material.spec.ts`  | **BYOK:** runner-owned log root; pending → material → coordinator issue. [System doc](tests/system/docs/README.md#non-custodian-log-root-signing-key-byok-delegation). |
| `system/coordinator-delegation-issuance.spec.ts` | Default system tier: **Custodian proxy** on KMS miss with runner-signed BYOK material. [Doc](tests/system/docs/coordinator-delegation-issuance.md).                    |

- Shared e2e utils: `e2e-env-guards.ts`, `e2e-bootstrap-variant.ts`, `e2e-grant-flags.ts`, …

**CI failure artifacts:** When the Playwright job fails, download the HTML report and attachments (e.g. `parent-grant-ab-split.json`):

```bash
gh run download <RUN_ID> -n playwright-report-dev-<RUN_ID> --repo forestrie/canopy
gh run download <RUN_ID> -n playwright-results-dev-<RUN_ID> --repo forestrie/canopy
```

- Worker unit/integration tests: `packages/apps/canopy-api/test`.
