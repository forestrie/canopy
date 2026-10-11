# Rules of the road — canopy (SCRAPI edge)

Cloudflare Workers: SCRAPI API, forestrie-ingress (SequencingQueue DO), x402
settlement, delegation coordinator. Load with [platform.md](https://github.com/forestrie/forestrie-agents/blob/main/rules-of-the-road/platform.md).
`⤷` = specialises a platform rule.

Glossary/links: [`arc-canopy` skill](https://github.com/forestrie/forestrie-agents/blob/main/arc-context/arc-canopy/SKILL.md).

---

### C1 — Offline verify calls nothing
Verify (layers A–C) uses only the supplied trust anchors / genesis COSE root —
never the network, coordinator, RPC, or a live tile read inside the verify path.
**Why:** offline verify is the headline claim; a hidden fetch makes it false.
⤷ specialises P2. [ADR-0045](https://github.com/forestrie/devdocs/blob/main/archive/2607/adr/adr-0045-receipt-verify-offline-contract.md).

### C2 — Enforce global logId→R uniqueness at grant POST
Grant POST checks an atomic `logId → R` index and returns 409 on conflict.
**Why:** cross-forest logId reuse would make authority resolution ambiguous and
enable grant replay.
⤷ specialises P14. [ADR-0036](https://github.com/forestrie/devdocs/blob/main/archive/2603/adr/adr-0036-global-logid-r-uniqueness.md).

### C3 — register-statement: grant kind + signer binding; canopy admission is THE leaf-signer enforcement point
Require `isStatementRegistrationGrant(grant)` (bitmap `GF_DATA_LOG | GF_EXTEND`).
Verify the **grant** (the `Forestrie-Grant` COSE Sign1) against the
**`ownerLogId` authority key or its delegate**. Verify the **statement** under
the signer the grant binds: COSE `kid == statementSignerBindingBytes(grant)` and
the signature under the `grantData` key — **or**, when the statement carries a
session-key endorsement (unprotected label `-65801`, ADR-0065), under the
session key that endorsement names, after the endorsement itself verifies under
the `grantData` root, UV per `GF_REQUIRES_USER_VERIFICATION`, within its
validity window. The (kid binding, verify key) pair comes from exactly ONE
source; a present-but-invalid endorsement is a 403 and never falls back.
**canopy admission is the enforcement point for who may sign a leaf, for every
custody shape** — nothing downstream (ranger, sealer, publisher, univocity)
re-checks a leaf signer, and a client-side pre-flight (e.g. the thinker DO)
never substitutes for it. **Why:** issuance authority (parent) and endorsed
signer (`grantData`) are structurally distinct — collapsing them is a forgery
vector; and admission is the last verifier on the path, so a fail-open here is a
fail-open for the whole chain.
⤷ specialises P10. [ARC-0019 §6](https://github.com/forestrie/devdocs/blob/main/archive/2603/arc/arc-0019-grant-verification-model.md) · [ADR-0065](https://github.com/forestrie/devdocs/blob/main/adr/adr-0065-endorsed-session-key-admission.md).

### C4 — Reject obsolete grant wire fields
Reject wire-v0 grant maps carrying keys 7/8 (legacy signer/kind); `grantData` is
the sole statement-signer binding. **Why:** accepting removed fields
re-introduces the ambiguity ARC-0019 eliminated.
⤷ specialises P16. [ARC-0019 §6.0](https://github.com/forestrie/devdocs/blob/main/archive/2603/arc/arc-0019-grant-verification-model.md) · [ADR-0048](https://github.com/forestrie/devdocs/blob/main/archive/2607/adr/adr-0048-encoding-owns-grant-wire-layer.md).

### C5 — Only the instance root is liable; meter per checkpoint
Fee liability is 1:1 with the univocity instance root (`chainBinding`); meter
per checkpoint against `CheckpointPublished` events, never per sub-log, and apply
the kill switch **forward-only**. **Why:** recoupment across the hierarchy is the
owner's problem — the operator must not learn or bill sub-delegate economics.
⤷ specialises P14. [ADR-0059](https://github.com/forestrie/devdocs/blob/main/archive/2607/adr/adr-0059-instance-root-fee-accounts.md) · [ARC-0026](https://github.com/forestrie/devdocs/blob/main/archive/2607/arc/arc-0026-onboard-grant-apis-and-fee-tracing.md).

### C6 — Admission policy is deployment config and self-describes
Admission (`vetted | paid | either`) is operator configuration; the redeem/
onboard response states which policy applied and records `admittedBy`. No
silently divergent behaviour between deployments. **Why:** the same API surface
must be auditable regardless of how a lane is configured.
[ARC-0026 §admission](https://github.com/forestrie/devdocs/blob/main/archive/2607/arc/arc-0026-onboard-grant-apis-and-fee-tracing.md).

### C7 — Child-log registration needs the parent grant, not an operator token
Registering a child public root requires the parent's create grant (parent
`K(L)`) — never an operator-issued onboard token. **Why:** hierarchy
independence — the operator is a fungible pipe, it does not confer authority.
⤷ specialises P9. [ADR-0053](https://github.com/forestrie/devdocs/blob/main/archive/2607/adr/adr-0053-child-log-onboarding-parent-authorized.md).

### C8 — CBOR is the default wire format
Responses are CBOR except `/api/health` and scitt-configuration; statement
status is async via 303 keyed on `contentHash`. **Why:** SCRAPI/SCITT interop is
byte-exact — a JSON convenience path drifts from what the contract verifies.
⤷ specialises P16. [`arc-canopy` skill](https://github.com/forestrie/forestrie-agents/blob/main/arc-context/arc-canopy/SKILL.md).

### C9 — Keep the three control planes separated by authority source
The **user** control plane authenticates by wallet challenge; **operator**
actions live behind `/admin/api/`; **public sealing** (certificate verify) is
unauthenticated-but-verified. A route in one plane MUST NOT accept another
plane's authority. **Why:** each plane's authority source is different — mixing
them lets one plane's credential act in another (FOR-129).
[ARC-0023](https://github.com/forestrie/devdocs/blob/main/archive/2606/arc/arc-0023-wallet-challenge-control-plane-auth.md).

### C10 — register-grant payment keeps payer, registrar, and subject decoupled
The x402 grant gate reads payment policy from the **parent** grant's committed
flags (per-hierarchy, transparency-logged — not a per-child flag) and prices per
child `maxHeight`; it never reads the payer's or subject's identity into
authority. The registrar is the only trusted role (L1); the payer is any funded
wallet (permissionless, EIP-3009), and who is on the hook for the burn is a
routing choice, provable from the settled payment `from`. Exempt a hierarchy by
**topology** (parent it under a bit-free authority log), never by an operator
token. **Why:** collapsing payer→operator — or reaching for the ops-admin token —
re-centralises what P6/U2 made permissionless and forecloses sponsorship/delegation.
⤷ specialises P6 (see also U2, C3, C5, C7).
[ARC-0029](https://github.com/forestrie/devdocs/blob/main/arc/arc-0029-derived-grant-policy-and-sender-bound-enforcement.md) ·
[ADR-0062](https://github.com/forestrie/devdocs/blob/main/adr/adr-0062-canopy-derived-grant-flag-registry.md) ·
[univocity ADR-0001](https://github.com/forestrie/univocity/blob/main/docs/adr/adr-0001-payer-attribution-permissionless-submission.md).
