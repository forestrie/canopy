# System e2e — `passkey-endorsed-session-seal.spec.ts`

**Spec:** `tests/system/passkey-endorsed-session-seal.spec.ts`
**Index:** [README.md](./README.md)
**Plan:** devdocs [plan-2608-14](https://github.com/forestrie/devdocs/blob/main/plans/plan-2608-14-endorsed-session-key-admission.md) 4.1 (Q12 gate 4);
[ADR-0065](https://github.com/forestrie/devdocs/blob/main/adr/adr-0065-endorsed-session-key-admission.md).

## Purpose

A **passkey-rooted data log** (thinker's user log) rebuilt on the deployed
stack from public artifacts: the log root is a synthetic passkey (`grantData`
= P-256 x‖y, `GF_REQUIRES_USER_VERIFICATION`), every per-turn leaf is signed
by an **endorsed session key** and carries the v2 endorsement at unprotected
label `-65801`. The synthetic assertion is byte-for-byte what an authenticator
produces (challenge = `sha256(Sig_structure)`, UP|UV, low-s), so no component
takes a test-only branch.

Kept deliberately: the plan-2608-13 5.2 live run was the only place canopy
admission was exercised for this topology, and it found the gap. This spec is
where it is exercised now.

## Auth hierarchy under test

```text
R (bootstrap root, sealed)
 └── A (auth log, Custodian custody key)          — thinker grant-authority
      └── U (data log, grantData = passkey x‖y, UV) — thinker user log
           leaves: kid = session x, -65801 = endorsement(root → session, window)
```

## Cases

| Test       | Case     | Path                                                          | Expected                                                                                                                |
| ---------- | -------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1 (always) | Negative | bare session-signed leaf, no endorsement (the 5.2 live bytes) | **403** `signer_mismatch`                                                                                               |
| 1          | Negative | valid endorsement under a **different** passkey               | **403** `endorsement_root_mismatch` (never falls back)                                                                  |
| 1          | Negative | endorsement gesture without UV on a UV grant                  | **403** `endorsement_uv_required`                                                                                       |
| 1          | Happy    | session-signed leaf carrying the endorsement                  | **303** content-hash Location on `U`                                                                                    |
| 2 (opt-in) | Happy    | standing WebAuthn delegation → sealer → receipt               | **200** receipt; cert (label 1000) verifies via the ADR-0063 envelope under the passkey with UV, **not** as plain ES256 |
| 2          | Happy    | `verifyEndorsedLeaf(root x‖y, leaf, receipt, idtimestamp)`    | `ok`; session key matches; receipted idtimestamp inside the window                                                      |

## Run

```bash
# Admission coverage (test 1) — part of the default system tier.
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
    tests/system/passkey-endorsed-session-seal.spec.ts

# Seal + offline rung (test 2) — opt-in stretch.
E2E_PASSKEY_SEAL_STRETCH=1 doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
    tests/system/passkey-endorsed-session-seal.spec.ts
```

Preflight (`task test:e2e:preflight`) must have provisioned the ephemeral
Univocity instances; the kit must be built (`pnpm --filter
@forestrie/canopy-e2e-kit build`) — the e2e package consumes `dist/`.

## Why test 2 is opt-in

The deployed sealer verifies delegation certificates as **plain ES256 over
`Sig_structure`** (arbor `delegationcert.VerifyCertificateSignature`, called
from `sealer/src/delegation_lease_verify.go`). A passkey root signs its
certificate as a WebAuthn assertion (`alg -65800`, signature over
`authenticatorData ‖ sha256(clientDataJSON)`), so the lease fails
`delegation cert signature invalid` and the receipt 404s to the deadline. The
coordinator intake (plan-2608-13 phase 2) and the publisher/publishproof lift
(phase 3) already handle the envelope; the sealer's lease verify does not.
Flip test 2 to default-on when it does.

The on-chain **publish** half (checkpoint anchored with 3-element `algData`)
is proven by arbor's anvil integration
`TestWebAuthnRootDelegatedPublishFromSealedCheckpoints` (plan-2608-13 3.5) and
by the 4.2 live re-run; canopy's e2e has no chain writer.

## Logical flow (auth) — happy

```text
[Base B on R] ──► auth grant O=R,T=A (custody) ──► receipt on R
A custody signs user grant O=A,T=U, grantData = passkey xy, UV flag
  (parentGrant = completed A)                          ──► receipt on R
Passkey: root ──endorse(v2, window)──► session key
Leaf: session signs {1:-7, 4: session x}, unprotected {-65801: endorsement}
Canopy: -65801 present ──► verify endorsement under grantData (UV per grant,
  window vs clock) ──► kid == session x, signature under session key ──► 303
[stretch] coordinator public-root(U) = passkey; standing delegation signed
  WebAuthn (cert envelope + on-chain assertion) ──► sealer lease ──► receipt
Offline: verifyEndorsedLeaf(root xy, leaf, receipt, idtimestamp) ──► ok
```
