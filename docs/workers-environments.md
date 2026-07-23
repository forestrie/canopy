# Worker environments (canopy-api)

## Worker names and routes

| Wrangler config        | Worker name in dashboard | Route (runtime from `CANOPY_FQDN` + aliases) | When it gets deployed                                                                       |
| ---------------------- | ------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Top-level (no `--env`) | **canopy-api**           | No route in wrangler (may use workers.dev) | Only when someone runs `wrangler deploy` without `ENV` from the app directory               |
| `--env dev` (Lane A)   | **canopy-api-dev**       | `api-a.{DNS_SUB}.{DNS_APEX}`                 | **Deploy Workers** workflow (push to main → dev, or workflow_dispatch with environment=dev) |
| `--env prod` (Lane B)  | **canopy-api-prod**      | `api-b.{DNS_SUB}.{DNS_APEX}` + alias `api-{DNS_SUB}.{DNS_APEX}` | **Deploy Workers** workflow_dispatch with environment=prod                                  |

All three configs include the **R2_GRANTS** binding (and R2_MMRS, DOs, etc.).

## Promotion lanes (Lane A / Lane B)

| Idea | Meaning |
|------|---------|
| **Lane A** (`dev`) | **canopy-api-dev**, ledger slot `a`, `api-a.{DNS_SUB}.{DNS_APEX}` |
| **Lane B** (`prod`) | **canopy-api-prod**, ledger slot `b`, `api-b.{DNS_SUB}.{DNS_APEX}` |
| **Production alias** | `api-{DNS_SUB}.{DNS_APEX}` on **canopy-api-prod** (Lane B only) |
| **Edge ingress** | Per-slot **`forestrie-ingress-{DNS_SUB}-{a|b}`** on **`ingress.{slot}.{DNS_SUB}.{DNS_APEX}`** |

Lane and slot are **coupled** on a single forest project: `CANOPY_PROMOTION_LANE`
selects Worker script, GitHub Environment, GKE slot, and catalog hostnames. See
**forest-1** [ADR-0004](../../forest-1/docs/adr-0004-symmetric-lane-hostnames.md).

Each API lane binds `SEQUENCING_QUEUE` to **`forestrie-ingress-{DNS_SUB}-{slot}`**
from the forest consumer contract.

Deployed **canopy-api-*** vars and bindings come from the GitHub Environment
(**`dev`** / **`prod`**) and
`packages/apps/canopy-api/scripts/apply-runtime-contract.mjs` at deploy time.

Forest bootstrap publishes and verifies the contract per lane; see **forest-1**
`docs/bootstrap-canopy-contract.md`.

## Perf test and dev traffic

- The **Performance Tests** workflow uses GitHub Environment **`dev`**, **`stage`**, or **`prod`**. Variables supply **`CANOPY_BASE_URL`**, etc.
- Dev perf traffic hits **canopy-api-dev** on **`api-a.{DNS_SUB}.{DNS_APEX}`** (Lane A).
- Prod perf uses **`CANOPY_FQDN`** from the prod GitHub Environment (Lane B canonical hostname).

## Deploying a feature branch to dev

**Deploy Workers** runs on **push to main** only (for automatic deploys). To get a feature branch onto **Lane A**:

1. In GitHub Actions, open **Deploy Workers**.
2. Click **Run workflow**.
3. Choose your branch in the dropdown.
4. Set **Deployment environment** to **dev**.
5. Run the workflow.

That deploys **canopy-api-dev** to **`api-a.{DNS_SUB}.{DNS_APEX}`**.

If you deploy from the repo root with `task wrangler:deploy:canopy-api` **without**
`ENV=dev`, you deploy the **canopy-api** (default) worker, which is **not** the one
serving the Lane A catalog hostname.

## forestrie-ingress (ledger HTTP queue API)

| Wrangler env | Worker name (dashboard)    | Route(s)                                 | Notes                                                                                                                                                                                                                                                                             |
| ------------ | -------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`dev`**    | **forestrie-ingress-dev**  | _(none — use `wrangler dev` locally)_    | Avoids overlapping zone routes with prod.                                                                                                                                                                                                                                         |
| **`prod`**   | **`forestrie-ingress-{DNS_SUB}-{slot}`** (runtime) | **`ingress.{slot}.{DNS_SUB}.{DNS_APEX}`** (Wrangler custom domain) | Per-slot edge ingress. Deploy both slots via **`deploy-forestrie-ingress.yml`** (`ledger_slot` input). |

## delegation-coordinator (Phase 3 management + issuance material store)

| Wrangler env | Worker name (dashboard)           | Route(s)                              | Notes |
| ------------ | ------------------------------- | ------------------------------------- | ----- |
| **`dev`** (Lane A) | **delegation-coordinator-dev**  | **`coordinator-a.{DNS_SUB}.{DNS_APEX}`** | Sharded `DelegationStoreDO`. Local `wrangler dev` on port **8793**. |
| **`prod`** (Lane B) | **delegation-coordinator-prod** | **`coordinator-b.{DNS_SUB}.{DNS_APEX}`** + alias **`coordinator.{DNS_SUB}.{DNS_APEX}`** | Distinct canonical hostnames; prod alias for public traffic. |

Secrets (per env): **`COORDINATOR_APP_TOKEN`**, **`CUSTODIAN_APP_TOKEN`**,
**`WALLET_CHALLENGE_SIGNING_SECRET`** (wallet-challenge session HMAC; ADR-0007).

Canopy-api GitHub Environment vars include **`SUPPORTED_CHAINS_RPC`** (JSON map;
ADR-0010). Legacy **`UNIVOCITY_CONTRACT_ADDRESS`** /
**`UNIVOCITY_CONTRACT_RPC_URL`** are removed.

**Self-service onboard (dev lane, FOR-166):** `canopy-api` dev worker vars include
`ONBOARD_AUTO_APPROVE=true` and `ONBOARD_AUTO_APPROVE_CHAIN_IDS=84532` in
`wrangler.jsonc` (never on prod — `NODE_ENV=prod` blocks auto-approve in code).
Public routes: `/api/onboarding/requests`. Ops JSON admin:
`/api/onboarding/admin/**`. Rate limit: `ONBOARD_CREATE_RATE_LIMITER` wrangler
binding. See [plan-0039](plans/plan-0039-self-service-onboard-provisioning.md).

**Webhook identity (account-level, ADR-0006):** `WEBHOOK_SIGNING_KEY` via Cloudflare
Secrets Store (`default_secrets_store` / `webhook-signing-key`). Bootstrap PEM in
Doppler `canopy` dev+prd (`task cf:coordinator:bootstrap-webhook-signing-key`);
CI runs `task cf:coordinator:ensure-webhook-signing-key` before deploy
(`WEBHOOK_SIGNING_KEY_PEM` GitHub Environment secret).

Forest bootstrap publishes **`DELEGATION_COORDINATOR_URL`** per lane into
`canopy_dev` / `canopy_prod` and syncs to GitHub **`dev`** / **`prod`**.

Legacy lane globals **`api-dev`** / **`coordinator-dev`** are retired — use catalog
FQDNs from **forest-1** [ARC-0003](../../forest-1/docs/arc-0003-ingress-and-dns-provisioning.md).

**Ops runbook:** [plan-0022](plans/plan-0022-delegation-coordinator-ops-parity.md), [forest-1 bootstrap-canopy-contract](../../forest-1/docs/bootstrap-canopy-contract.md).

## x402-settlement (USDC settlement worker)

| Wrangler config | Worker name | Queue consumed | `X402_NETWORK` (configured) |
| --------------- | ----------- | -------------- | --------------------------- |
| Top-level (no `--env`) | **x402-settlement** | none | `eip155:84532` — unused by CI |
| `--env dev` (Lane A) | **x402-settlement-dev** | `canopy-dev-1-x402-settlement` | `eip155:84532` — Base Sepolia |
| `--env prod` (Lane B) | **x402-settlement-prod** | `canopy-prod-1-x402-settlement` | `eip155:8453` — **see the drift warning below** |

> **Both lanes run on Base Sepolia today. Lane B ("prod") is effectively a
> staging lane** — the mainnet cutover is deliberate and has not happened.
> `demo/preflight.sh` puts it plainly: *"DEPLOY_KEY is a Base Sepolia gas-only
> payer (same chain both lanes)"*.
>
> **Config drift — `X402_NETWORK` on the prod lane is ahead of reality.**
> `eip155:8453` (Base mainnet) appears in exactly **two** places in the whole
> platform: the prod env of `x402-settlement/wrangler.jsonc` and
> `canopy-api/wrangler.jsonc`. Nothing else — no Univocity deployment, no
> chain-rpc entry, no test fixture — references mainnet. Those two literals
> therefore contradict the lane they sit in.
>
> This is currently harmless because nothing enqueues a `SettlementJob` (the
> producer was removed in Plan 0001 and never reinstated — see
> [FOR-80](https://linear.app/forestrie/issue/FOR-80)), so the worker is
> dormant. It stops being harmless the moment a producer lands: prod would
> attempt a **mainnet** settlement on a lane whose every other component is on
> Sepolia — the accident [FOR-83](https://linear.app/forestrie/issue/FOR-83)
> exists to prevent, arriving by config drift rather than by decision.
>
> **Before any producer lands** ([FOR-434](https://linear.app/forestrie/issue/FOR-434)),
> either set the prod lane to `eip155:84532` to match reality and flip it as
> part of the FOR-83 mainnet cutover, or land FOR-83's amount cap and
> kill-switch first. Do not leave both halves to arrive independently.

Unlike the other three workers, x402-settlement has **no**
`scripts/apply-runtime-contract.mjs`, so its `CANOPY_ID`, queue names and
`X402_NETWORK` are **frozen literals** in `wrangler.jsonc`. Note canopy-api
*derives* the settlement worker's script name from its injected `CANOPY_ID`
(`apply-runtime-contract.mjs` → `x402-settlement-${lane}`), so the two can drift.
Closing that asymmetry is tracked separately.

### CDP credential mapping (FOR-79)

`CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` authenticate to the Coinbase CDP
facilitator for `/verify` and `/settle`.

| Origin | Transport | Consumer | Secret |
| ------ | --------- | -------- | ------ |
| GitHub **Environment** `dev` | `deploy-workers.yml` → `wrangler secret put --env dev` | `x402-settlement-dev`, `canopy-api-dev` | `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` |
| GitHub **Environment** `prod` | `deploy-workers.yml` → `wrangler secret put --env prod` | `x402-settlement-prod`, `canopy-api-prod` | same |

**Format:** `CDP_API_KEY_SECRET` must be a **PKCS#8 PEM P-256** key. `importPemKey`
(`packages/apps/x402-settlement/src/index.ts`) does `pemKey.replace(/\\n/g,"\n")`
then `crypto.subtle.importKey("pkcs8", …, {name:"ECDSA", namedCurve:"P-256"})` —
literal `\n` escapes are tolerated, **SEC1 keys throw**. The SEC1 fallback in that
function is a comment and a `throw`; it does not actually wrap SEC1.

> **What is in Doppler today does not import. Do not copy it across as-is.**
> CDP credentials already exist in Doppler — projects **`coinbase-x402`** and
> **`canopy`**, configs `dev` / `stg` / `prd` / `dev_personal`, all holding
> identical values (so there is no dev/prod separation either). Neither stored
> form is usable by this worker; both were verified empirically against the
> worker's exact import path:
>
> | Stored key | Form | `importKey("pkcs8", …, ECDSA P-256)` |
> |---|---|---|
> | `COINBASE_API_KEY_ECDSA` | **SEC1** PEM, with literal `\n` escapes | ✗ throws `Invalid keyData` |
> | `CDP_API_KEY_SECRET` | base64, no PEM header, decodes to **64 bytes** (a P-256 PKCS#8 DER is ~138 — this is Ed25519-shaped, a different CDP key type) | ✗ throws `Invalid keyData` |
> | the SEC1 key converted with `openssl pkcs8 -topk8 -nocrypt` | **PKCS#8** PEM | ✓ imports as P-256 |
>
> So Phase 2 is a **format conversion**, not a key hunt. Convert once, store the
> PKCS#8 form, and keep per-lane keys so a testnet credential can never settle
> real funds after the mainnet cutover.

**Verify after deploy:** `GET /health` on the settlement worker returns
`hasCdpCredentials`. It must be `true` on both lanes.

**Failure mode is silent.** Without credentials `/verify` and `/settle` return 500
`"facilitator not configured"`, and the queue consumer returns `permanent:true`,
which increments `failure_count` and **blocks the payer's auth after 10 failures** —
revenue loss presenting as a payer bug.

**Origin is not yet Doppler.** These two are currently hand-set GitHub Environment
secrets (2026-03-22) and are **not** in forest-1's
`bootstrap:canopy:sync-github-env` list, unlike every other canopy secret. Moving
them into `canopy_dev` / `canopy_prod` so Doppler is the single origin is FOR-79
Phase 2. **No rotation owner or procedure is defined yet** — contrast the
documented blue/green rotation for the Cloudflare platform token in
[forest-1 doppler.md](../../forest-1/docs/doppler.md).

> The forward standard for all canopy workers is GitHub→Doppler **OIDC pull**
> per [ADR-0049](../../devdocs/adr/adr-0049-doppler-github-oidc-worker-deploy.md)
> (already implemented in `mandate`). The Doppler→Cloudflare **native sync**
> proposed in [plan-0002](plans/plan-0002-doppler-secrets-migration.md) was never
> implemented and is **explicitly rejected** by that ADR — do not build it.

## CI / e2e targeting

| GitHub Environment | Lane | Doppler `canopy` config | Typical `CANOPY_FQDN` | Playwright |
| ------------------ | ---- | ----------------------- | --------------------- | ---------- |
| **`dev`** | Lane A | **`dev`** | `api-a.{DNS_SUB}.{DNS_APEX}` | **integration** (`tests-integration.yml`); **system** suite (`tests-system.yml` via deploy-workers or manual) |
| **`prod`** | Lane B | **`prd`** | `api-b.{DNS_SUB}.{DNS_APEX}` | Release promotes Lane A → B after **tests-system.yml** on dev; prod health only |

**Release (`v*` tag):** deploy tagged commit to **dev** → system e2e gate → deploy same commit to **prod** (Lane B promotion).

Both lanes can target the same **`FOREST_PROJECT_ID`** with different GKE slots and
hostnames. Do not override slot on the dev lane — use **`CANOPY_PROMOTION_LANE=prod`**
for Lane B promotion drills.
