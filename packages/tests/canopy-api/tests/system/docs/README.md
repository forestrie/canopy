# System e2e — test index

Spec files: `tests/system/*.spec.ts`. Shared flows:
[overview.md](./overview.md) (mint, register → receipt, register statement).

**Playwright project:** `system` (`pnpm --filter @canopy/api-e2e test:e2e:system`).

## Spec map

| Spec file                                 | Doc                                                                        | Depends on base flow   |
| ----------------------------------------- | -------------------------------------------------------------------------- | ---------------------- |
| `grants-bootstrap.spec.ts`                | [grants-bootstrap.md](./grants-bootstrap.md)                               | A, B                   |
| `bootstrap-log-first-entry.spec.ts`       | [bootstrap-log-first-entry.md](./bootstrap-log-first-entry.md)             | A, B, C                |
| `bootstrap-child-auth-grant.spec.ts`      | [bootstrap-child-auth-grant.md](./bootstrap-child-auth-grant.md)           | A, B                   |
| `auth-data-log-chain.spec.ts`             | [auth-data-log-chain.md](./auth-data-log-chain.md)                         | A, B, C                |
| `coordinator-delegation-issuance.spec.ts` | [coordinator-delegation-issuance.md](./coordinator-delegation-issuance.md) | _(opt-in; not SCRAPI)_ |

---

## Non-Custodian log-root signing key (BYOK delegation)

**Terminology:** “Signing key not held by Custodian” here means the **log root key**
that signs **delegation certificates** (BYOK checkpoint authority), **not** the
delegated checkpoint signer in `grantData`. All SCRAPI specs below mint and sign
grants/statements via **Custodian KMS custody keys**.

Default `task test:e2e:doppler` / `test:e2e:system` does **not** exercise
non-Custodian log-root signing. For BYOK delegation e2e, run the coordinator tier
(always) and optionally the stretch spec (Custodian proxy hop).

### E2e coverage

| Spec                                                                                              | Playwright project | Opt-in?                                  | Non-Custodian key signs                      | Custodian role                                          |
| ------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------- | -------------------------------------------- | ------------------------------------------------------- |
| [`coordinator-byok-material.spec.ts`](../../coordinator/coordinator-byok-material.spec.ts)        | **coordinator**    | No (`test:e2e:coordinator`)              | Delegation cert (`generateEs256RootKeyPair`) | None — coordinator direct issue                         |
| [`coordinator-byok-public-root.spec.ts`](../../coordinator/coordinator-byok-public-root.spec.ts)  | **coordinator**    | No (`test:e2e:coordinator`)              | Root + delegation cert                       | None — `GET …/public-root` CBOR trust root              |
| [`coordinator-delegation-issuance.spec.ts`](../../system/coordinator-delegation-issuance.spec.ts) | **system**         | Yes — `E2E_COORDINATOR_SEALER_STRETCH=1` | Same runner-signed delegation cert           | **Proxy only** — `POST /v1/api/delegations` on KMS miss |

Both assert crypto via `verifyByokDelegationCertificate` in
[`coordinator-delegation-helpers.ts`](../../utils/coordinator-delegation-helpers.ts).

**Not BYOK:** `coordinator-api.spec.ts` (custodial pre-mint); all other
`tests/system/*.spec.ts`; `bootstrap-log-first-entry` negative (ephemeral key → **403** only).

### Not yet covered in e2e

| Gap                                                   | Future work                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| SCRAPI register-grant with non-Custodian grant signer | [arbor plan-0003](https://github.com/forestrie/arbor/blob/main/docs/plan-0003-non-custodial-checkpoint-support.md) |
| Sealer consuming coordinator `public-root` on stack   | [arbor plan-0005](https://github.com/forestrie/arbor/blob/main/docs/plan-0005-sealer-trust-root-end-to-end.md)     |
| Canopy receipt verify BYOK in Playwright              | plan-0003 receipt-authority phase                                                                                  |
| Full checkpoint seal with BYOK delegation             | plan-0005                                                                                                          |

```bash
# Primary BYOK (coordinator tier)
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e test:e2e:coordinator

# System tier + Custodian proxy (opt-in)
E2E_COORDINATOR_SEALER_STRETCH=1 doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
    tests/system/coordinator-delegation-issuance.spec.ts
```

---

## `grants-bootstrap.spec.ts`

**Focus:** Root bootstrap mint wire format; register-grant on **cold** MMRS; full
receipt poll; second register with **completed** grant.

### Auth hierarchy under test

```text
R (root)  —  O = T = R, genesis-bound grantData, create+extend flags
```

### Cases

| Case  | Path                                     | Expected                                                                                          |
| ----- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Happy | Mint only                                | Custodian-profile transparent statement (COSE + grant v0 header)                                  |
| Happy | `POST /register/{R}/grants` (fresh UUID) | **303** Location under `/logs/{R}/{R}/entries/{innerHex}`                                         |
| Happy | Mint + poll + `GET` receipt              | **200** SCITT receipt CBOR; `mmrIndex === 0`; second register **303** with same inner in Location |

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

| Case     | Path                                                     | Expected                               |
| -------- | -------------------------------------------------------- | -------------------------------------- |
| Happy    | `beforeAll`: bootstrap + receipt                         | Shared completed grant                 |
| Happy    | Custodian sign statement + `POST /register/{R}/entries`  | **303** Location with **content-hash** |
| Negative | Ephemeral P-256 Sign1 (wrong kid) + same completed grant | **403** `signer_mismatch`              |

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

| Case  | Path                                                      | Expected                             |
| ----- | --------------------------------------------------------- | ------------------------------------ |
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

| Case     | Path                                                                | Expected                      |
| -------- | ------------------------------------------------------------------- | ----------------------------- |
| Happy    | `beforeAll`: root bootstrap + receipt                               | Shared `rootLogId`            |
| Happy    | Register auth grant on R, data grant on A, delegated sign + entries | **303** content-hash on **D** |
| Negative | Same chain but statement signed by **auth** custody key             | **403** `signer_mismatch`     |

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

**Focus:** Opt-in stretch (`E2E_COORDINATOR_SEALER_STRETCH=1`). **System-tier e2e**
for **log root keys not held by Custodian**: runner signs delegation material,
coordinator stores it, **Custodian proxies** `POST /v1/api/delegations` on KMS miss.
Not the SCRAPI register-grant chain.

Coordinator-only twin (503 pending → material → coordinator direct issue):
[`coordinator-byok-material.spec.ts`](../../coordinator/coordinator-byok-material.spec.ts).

See [coordinator-delegation-issuance.md](./coordinator-delegation-issuance.md).

---

## Other e2e tiers (not in `tests/system/docs/` per spec)

| Project     | Directory            | Role                                                                                                                                       |
| ----------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| integration | `tests/integration/` | Canopy-only health / SCRAPI discovery / CORS                                                                                               |
| custodian   | `tests/custodian/`   | Direct Custodian `/v1/api/…`                                                                                                               |
| coordinator | `tests/coordinator/` | Phase 3 coordinator APIs; **BYOK** (`coordinator-byok-material`, `coordinator-byok-public-root`); custodial pre-wallet (`coordinator-api`) |

Package index: [../../../README.md](../../../README.md).
