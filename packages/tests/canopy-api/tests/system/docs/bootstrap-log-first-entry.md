# System e2e — `bootstrap-log-first-entry.spec.ts`

**Spec:** `tests/system/bootstrap-log-first-entry.spec.ts`  
**Index:** [README.md](./README.md)  
**Prerequisites:** [overview.md](./overview.md) — flows A, B, C

Serial suite with shared `beforeAll`: one root bootstrap + receipt, then two
tests against the same **completed grant**.

## What this spec proves

- After root bootstrap, **`POST /register/{R}/entries`** accepts a COSE Sign1
  statement when the Sign1 `kid` matches the **root signer** bound in the
  completed grant’s `grantData` (ES256: 32-byte x; KS256: 20-byte address).
- A statement signed with a **different** key is rejected with
  **`signer_mismatch`** even when the grant/receipt are valid.

## Auth under test

```text
R  (root)
   completedGrant: receipt inclusion on R + grantData = root signer binding
   statement: COSE Sign1 kid MUST match grantData (x or KS256 address)
```

| Check               | Mechanism                                                      |
| ------------------- | -------------------------------------------------------------- |
| Grant authorization | `grantAuthorize` — completed Forestrie-Grant + receipt         |
| Statement signer    | Compare Sign1 protected `kid` to `statementSignerBindingBytes` |

## Test cases

### Shared `beforeAll`

Runs [base flow B](./overview.md#base-flow-b--register-grant-through-scitt-receipt) on
`e2eReceiptBootstrapRootLogId()` → `shared.completedGrantB64`,
`shared.rootCustodySignKeyId`.

### 1. POST /register/entries returns 303 with content-hash Location

**Happy path.**

```mermaid
sequenceDiagram
    participant PT as Playwright
    participant CUS as Custodian
    participant API as Canopy API
    participant DO as SequencingQueue DO
    participant RNG as Ranger
    participant R2 as R2 MMRS

    Note over PT: beforeAll completedGrant(R)

    PT->>CUS: POST /v1/api/keys/{rootKey}/sign (statement CBOR)
    CUS-->>PT: COSE Sign1
    PT->>API: POST /register/{R}/entries<br/>Forestrie-Grant completed + Sign1
    API->>API: grantAuthorize + signer binding OK
    API->>DO: enqueue statement (shard by T=R)
    API-->>PT: 303 Location (sha256 of Sign1 bytes)

    RNG->>DO: pull / ack
    RNG->>R2: append statement leaf
```

### 2. POST /register/entries rejects wrong signer

**Negative path** — no Custodian call; ephemeral browser key.

```mermaid
sequenceDiagram
    participant PT as Playwright
    participant API as Canopy API

    Note over PT: beforeAll completedGrant(R)
    PT->>PT: generateKey P-256 (wrong kid)
    PT->>PT: signCoseSign1Statement locally
    PT->>API: POST /register/{R}/entries
    API->>API: kid ≠ grantData pubkey
    API-->>PT: 403 signer_mismatch
```

## Helpers

- `postLogEntriesCoseSign1` — `tests/utils/post-entries-e2e.ts`
- `postCustodianSignRawPayloadBytes` — happy path signing
- `assert303ContentHashLocation` — Location contains expected content hash

## Auth-focused logical flow

```text
[Flow B] ──► completedGrant(R)
             │
             ├─► Happy: sign with root custody kid ──► 303 enqueue
             └─► Negative: sign with other kid ──► 403 signer_mismatch
```
