# System e2e — test index

Spec files: `tests/system/*.spec.ts`. Shared flows:
[overview.md](./overview.md) (mint, register → receipt, register statement).

**Playwright project:** `system` (`pnpm --filter @canopy/api-e2e test:e2e:system`).

## Spec map

| Spec file | Doc | Depends on base flow |
|-----------|-----|----------------------|
| `grants-bootstrap.spec.ts` | [grants-bootstrap.md](./grants-bootstrap.md) | A, B |
| `bootstrap-log-first-entry.spec.ts` | [bootstrap-log-first-entry.md](./bootstrap-log-first-entry.md) | A, B, C |
| `bootstrap-child-auth-grant.spec.ts` | [bootstrap-child-auth-grant.md](./bootstrap-child-auth-grant.md) | A, B |
| `auth-data-log-chain.spec.ts` | [auth-data-log-chain.md](./auth-data-log-chain.md) | A, B, C |
| `coordinator-delegation-issuance.spec.ts` | [coordinator-delegation-issuance.md](./coordinator-delegation-issuance.md) | *(opt-in; not SCRAPI)* |

---

## `grants-bootstrap.spec.ts`

**Focus:** Root bootstrap mint wire format; register-grant on **cold** MMRS; full
receipt poll; second register with **completed** grant.

### Auth hierarchy under test

```text
R (root)  —  O = T = R, genesis-bound grantData, create+extend flags
```

### Cases

| Case | Path | Expected |
|------|------|----------|
| Happy | Mint only | Custodian-profile transparent statement (COSE + grant v0 header) |
| Happy | `POST /register/{R}/grants` (fresh UUID) | **303** Location under `/logs/{R}/{R}/entries/{innerHex}` |
| Happy | Mint + poll + `GET` receipt | **200** SCITT receipt CBOR; `mmrIndex === 0`; second register **303** with same inner in Location |

### Logical flow (auth)

```text
Curator genesis(R) ──► grantData xy = genesis
Custodian sign ──► Forestrie-Grant
Canopy: no MMRS tile ──► bootstrap verify ──► enqueue on R
Ranger/Sealer ──► receipt
Completed grant ──► receipt branch still accepts register-grant
```

---

## `bootstrap-log-first-entry.spec.ts`

**Focus:** First **statement** on bootstrapped root using **completed** grant;
**signer binding** to root custody key in `grantData`.

### Auth hierarchy under test

```text
R  —  completed grant (receipt on R); statement kid must match grantData (root custody)
```

### Cases

| Case | Path | Expected |
|------|------|----------|
| Happy | `beforeAll`: bootstrap + receipt | Shared completed grant |
| Happy | Custodian sign statement + `POST /register/{R}/entries` | **303** Location with **content-hash** |
| Negative | Ephemeral P-256 Sign1 (wrong kid) + same completed grant | **403** `signer_mismatch` |

### Logical flow (auth)

```text
[Base B on R] ──► completedGrant(R)
Custodian sign(statement) with root custody kid
Canopy: grantAuthorize(receipt) + kid == grantData pubkey
Enqueue statement on T = R
```

---

## `bootstrap-child-auth-grant.spec.ts`

**Focus:** **Child auth** grant (`logId = A`, `ownerLogId = R`); leaf sequences on
**parent** `R`; status URL uses `/logs/{R}/{R}/entries/…` not `/logs/{R}/{A}/…`.

### Auth hierarchy under test

```text
R (root, MMRS-hot)
 └── A (auth child)  —  ownerLogId = R, auth-log-shaped flags, grantData = child custody xy
```

### Cases

| Case | Path | Expected |
|------|------|----------|
| Happy | Root bootstrap + receipt, then child auth register + poll | **303** parent path; receipt **200** |

### Logical flow (auth)

```text
[Base B on R]
Create custody key(selfLogId=A) ──► sign child grant (O=R, T=A)
Canopy: parent R MMRS-hot ──► child-auth-first verify (grantData, curator)
Enqueue on owner O = R
Poll receipt for grant leaf on R
```

---

## `auth-data-log-chain.spec.ts`

**Focus:** Root → **auth** log → **data** log; **delegated signer** in data
`grantData`; statement on data log; negative uses auth key instead of delegate.

### Auth hierarchy under test

```text
R
 └── A (auth)
      └── D (data)  —  grantData on D embeds delegated pubkey; statements on D
```

### Cases

| Case | Path | Expected |
|------|------|----------|
| Happy | `beforeAll`: root bootstrap + receipt | Shared `rootLogId` |
| Happy | Register auth grant on R, data grant on A, delegated sign + entries | **303** content-hash on **D** |
| Negative | Same chain but statement signed by **auth** custody key | **403** `signer_mismatch` |

### Logical flow (auth) — happy

```text
[Base B on R]
Auth grant: O=R, T=A  ──► receipt (leaf on R)
Data grant: O=A, T=D, grantData=delegate xy  (signed by auth custody)
[Base B] on D path via register-grant ──► completedGrant(D)
Custodian sign(statement) with delegate kid
Canopy: kid matches grantData on D ──► enqueue on T=D
```

### Logical flow (auth) — negative

```text
Same completedGrant(D)
Sign with auth custody kid (not in D.grantData) ──► signer_mismatch
```

---

## `coordinator-delegation-issuance.spec.ts`

**Focus:** Opt-in stretch (`E2E_COORDINATOR_SEALER_STRETCH=1`). Manual slice for
coordinator material + signing-route APIs composed with **Custodian local**
`POST /api/delegations` — **not** the SCRAPI register-grant chain and **not** the
planned Custodian → Coordinator proxy loop (see doc for BYOK / in-flight limitations).
Default CI **does not** run this file in `test:e2e:system`.

**BYOK / coordinator issue:** use `tests/coordinator/coordinator-byok-material.spec.ts`.

See [coordinator-delegation-issuance.md](./coordinator-delegation-issuance.md).

---

## Other e2e tiers (not in `tests/system/docs/` per spec)

| Project | Directory | Role |
|---------|-----------|------|
| integration | `tests/integration/` | Canopy-only health / SCRAPI discovery / CORS |
| custodian | `tests/custodian/` | Direct Custodian `/v1/api/…` |
| coordinator | `tests/coordinator/` | Phase 3 coordinator + Custodian delegations |

Package index: [../../../README.md](../../../README.md).
