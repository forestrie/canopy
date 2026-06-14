# Worker environments (canopy-api)

## Worker names and routes

| Wrangler config        | Worker name in dashboard | Route (runtime from `CANOPY_FQDN`)        | When it gets deployed                                                                       |
| ---------------------- | ------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| Top-level (no `--env`) | **canopy-api**           | No route in wrangler (may use workers.dev) | Only when someone runs `wrangler deploy` without `ENV` from the app directory               |
| `--env dev` (Lane A)   | **canopy-api-dev**       | `api-{DNS_SUB}.{DNS_APEX}/*`              | **Deploy Workers** workflow (push to main → dev, or workflow_dispatch with environment=dev) |
| `--env prod` (Lane B)  | **canopy-api-prod**      | `api-b.{DNS_SUB}.{DNS_APEX}/*`            | **Deploy Workers** workflow_dispatch with environment=prod                                  |

All three configs include the **R2_GRANTS** binding (and R2_MMRS, DOs, etc.).

## Promotion lanes (Lane A / Lane B)

| Idea | Meaning |
|------|---------|
| **Lane A** (`dev`) | **canopy-api-dev**, ledger slot `a`, `api-{DNS_SUB}.{DNS_APEX}` |
| **Lane B** (`prod`) | **canopy-api-prod**, ledger slot `b`, `api-b.{DNS_SUB}.{DNS_APEX}` |
| **Edge ingress** | Per-slot **`forestrie-ingress-{DNS_SUB}-{a|b}`** on **`ingress.{slot}.{DNS_SUB}.{DNS_APEX}`** |

Lane and slot are **coupled** on a single forest project: `CANOPY_PROMOTION_LANE`
selects Worker script, GitHub Environment, GKE slot, and catalog hostnames. See
**forest-1** [ADR-0003](../../forest-1/docs/adr-0003-lane-ab-promotion-model.md).

Each API lane binds `SEQUENCING_QUEUE` to **`forestrie-ingress-{DNS_SUB}-{slot}`**
from the forest consumer contract.

Deployed **canopy-api-*** vars and bindings come from the GitHub Environment
(**`dev`** / **`prod`**) and
`packages/apps/canopy-api/scripts/apply-runtime-contract.mjs` at deploy time.

Forest bootstrap publishes and verifies the contract per lane; see **forest-1**
`docs/bootstrap-canopy-contract.md`.

## Perf test and dev traffic

- The **Performance Tests** workflow uses GitHub Environment **`dev`**, **`stage`**, or **`prod`**. Variables supply **`CANOPY_BASE_URL`**, etc.
- Dev perf traffic hits **canopy-api-dev** on **`api-{DNS_SUB}.{DNS_APEX}`** (Lane A).
- Prod perf uses **`CANOPY_FQDN`** from the prod GitHub Environment (Lane B hostname when on the same forest project).

## Deploying a feature branch to dev

**Deploy Workers** runs on **push to main** only (for automatic deploys). To get a feature branch onto **Lane A**:

1. In GitHub Actions, open **Deploy Workers**.
2. Click **Run workflow**.
3. Choose your branch in the dropdown.
4. Set **Deployment environment** to **dev**.
5. Run the workflow.

That deploys **canopy-api-dev** to **`api-{DNS_SUB}.{DNS_APEX}`**.

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
| **`dev`** (Lane A) | **delegation-coordinator-dev**  | **`coordinator.{DNS_SUB}.{DNS_APEX}`** | Sharded `DelegationStoreDO`. Local `wrangler dev` on port **8793**. |
| **`prod`** (Lane B) | **delegation-coordinator-prod** | **`coordinator-b.{DNS_SUB}.{DNS_APEX}`** (runtime) | Distinct hostname so both coordinators can run on one forest project. |

Secrets (per env): **`COORDINATOR_APP_TOKEN`**, **`CUSTODIAN_APP_TOKEN`**.

Forest bootstrap publishes **`DELEGATION_COORDINATOR_URL`** per lane into
`canopy_dev` / `canopy_prod` and syncs to GitHub **`dev`** / **`prod`**.

Legacy lane globals **`api-dev`** / **`coordinator-dev`** are retired — use catalog
FQDNs from **forest-1** [ARC-0003](../../forest-1/docs/arc-0003-ingress-and-dns-provisioning.md).

**Ops runbook:** [plan-0022](plans/plan-0022-delegation-coordinator-ops-parity.md), [forest-1 bootstrap-canopy-contract](../../forest-1/docs/bootstrap-canopy-contract.md).

## CI / e2e targeting

| GitHub Environment | Lane | Doppler `canopy` config | Typical `CANOPY_FQDN` | Playwright project |
| ------------------ | ---- | ----------------------- | --------------------- | ------------------ |
| **`dev`** | Lane A | **`dev`** | `api-{DNS_SUB}.{DNS_APEX}` | `system` (deploy-workers on main) |
| **`prod`** | Lane B | **`prd`** | `api-b.{DNS_SUB}.{DNS_APEX}` | `prod` |

Both lanes can target the same **`FOREST_PROJECT_ID`** with different GKE slots and
hostnames. Do not override slot on the dev lane — use **`CANOPY_PROMOTION_LANE=prod`**
for Lane B promotion drills.
