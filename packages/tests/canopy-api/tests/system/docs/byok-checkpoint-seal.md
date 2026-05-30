# System e2e — `byok-checkpoint-seal.spec.ts` (stretch)

**Spec:** `tests/system/byok-checkpoint-seal.spec.ts`  
**Index:** [README.md](./README.md)

**Opt-in:** `E2E_BYOK_SEAL_STRETCH=1` plus coordinator, curator, and custodian env
vars. Skipped in default `test:e2e:system`.

## Purpose

End-to-end proof of BYOK checkpoint sealing: runner-held log root,
coordinator `public-root`, Sealer ephemeral delegated keys, wallet-signed
material, Ranger massif commit, R2 checkpoint, and SCRAPI receipt verification.

## Flow

```mermaid
sequenceDiagram
    participant PT as Playwright
    participant API as canopy-api
    participant COO as coordinator
    participant Q as sealer_queue
    participant SE as Sealer

    PT->>COO: POST public-root + signing-route wallet
    PT->>API: POST register-grant
    loop status_and_receipt_poll
        PT->>COO: GET pending-delegation
        PT->>COO: POST material when pending non-empty
        PT->>API: GET status or receipt
    end
    Q->>SE: massif notification
    SE->>COO: POST delegations 202 until material
    SE->>API: checkpoint in R2
    API-->>PT: receipt 200
```

## Differences from coordinator BYOK specs

| Aspect | `coordinator-byok-material` | This stretch |
|--------|------------------------------|--------------|
| Pending creation | Explicit `POST /api/delegations` | Sealer-driven |
| Checkpoint / receipt | No | Full SCRAPI poll |
| Custodian | None | Genesis + grants via Custodian |

## Operational notes

- Use catalog `CANOPY_BASE_URL` (e.g. `api-forest-2.forestrie.dev`), not stale
  Doppler `api-dev` hosts.
- Status may redirect to receipt URL before checkpoint exists; the spec polls
  `GET …/receipt` until 200.
- Poll stats: if material was signed but receipt stays 404 with empty pending,
  check Sealer logs for `verify delegation lease` errors.

## Run

```bash
E2E_BYOK_SEAL_STRETCH=1 \
  CANOPY_BASE_URL=https://api-forest-2.forestrie.dev \
  CUSTODIAN_URL=https://api-forest-2.forestrie.dev \
  doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
    tests/system/byok-checkpoint-seal.spec.ts
```
