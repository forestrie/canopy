# IETF demo video — MMR receipts profile (offline receipts + split-view protection)

**Status:** DRAFT
**Date:** 2026-07-10
**Scope:** multi-repo — canopy, univocity, arbor (mandate explicitly out of scope)
**Related:** [scitt-hackathon.md](./scitt-hackathon.md),
[draft-bryce COSE Receipts MMR profile](https://robinbryce.github.io/draft-bryce-cose-receipts-mmr-profile/draft-bryce-cose-receipts-mmr-profile.html),
[Univocity ARC-0017 §5.1](https://github.com/forestrie/univocity/blob/main/docs/arc/arc-0017-auth-overview.md#51-off-chain-ingress-vs-this-contract-forestrie--canopy),
[publisher proof-rebase status](https://github.com/forestrie/devdocs/blob/main/status/status-2607-01-publisher-proof-rebase.md)
(local: `../../../devdocs/status/status-2607-01-publisher-proof-rebase.md`)

Storyboard + shot list for a two-part demo video supporting **adoption of the
draft-bryce MMR profile** at IETF (Jon Geater presenting; robinbryce co-author).
Format: **slides + embedded terminal clips**. Two deliverables — a short
**teaser** and a longer **deep-dive** — sharing one framing.

> **Editorial rule:** every on-camera command must be one an outside engineer
> can re-run. Prefer **Tier A** (zero-secret) commands for anything shown
> executing live; use pre-recorded footage for the secret-bound live-chain
> beats. See [Repeatability tiers](#repeatability-tiers).

---

## 1. Thesis (the framing both videos share)

The MMR profile buys two properties, and the point is that **they compose**:

1. **Offline receipts.** A receipt is a COSE Sign1 carrying its own inclusion
   proof at header label **396**. You verify it with only the receipt bytes and
   a genesis trust anchor — no call back to the service.
2. **Split-view protection.** Checkpoints anchor a *single monotonic MMR
   accumulator per log* to a Univocity contract. The operator cannot commit two
   divergent histories: a fork is rejected on-chain.

**Why they compose (the adoption argument):** an offline receipt is only
*trustworthy* if you are convinced the log is not showing you a split view. The
MMR "old-accumulator compatibility" property means a pre-signed peak receipt
stays valid as the tree grows *as long as the log is consistent*
(`arbor/services/_deps/go-merklelog/massifs/mmriver.go:182`). The profile makes
receipts offline-checkable; the on-chain anchor makes the no-split-view premise
*enforceable*. That is the whole story in one sentence — put it on the thesis
slide.

**Deliberately off-camera** (per scope): grants, statement auth, BYOK, and the
auth/data-log tree internals. The receipt + checkpoint + split-view story needs
none of them. **Mandate is out of scope** — it only adds the Privy / Cloudflare
/ onboard-token / secret surface we are avoiding.

---

## 2. Repeatability tiers

The single most valuable finding from the July survey: the hero beats run with
**no secrets**. Build the videos on Tier A; keep B/C as pre-recorded evidence.

| Tier | Needs | Proves | Command |
|------|-------|--------|---------|
| **A** | clone + pnpm | offline receipt verify + tamper-reject | `pnpm --filter @forestrie/receipt-verify test` |
| **A** | clone + Foundry | forked checkpoint rejected (in-EVM) | `forge test --match-test test_publishCheckpoint_revertsOnSizeDecrease -vvv` |
| **A** | clone + Go | proof chain verified exactly as the contract | `cd arbor/services/pkgs/publishproof && go test -run BuildEmbeddedProofChain ./...` |
| **B** | + anvil/foundry | sealed checkpoint mined by `publishCheckpoint` on a local chain | `cd arbor/services/pkgs/publishproof && go test -run TestDelegatedPublishFromSealedCheckpoint ./...` |
| **C** | Doppler + funded RPC | live register→receipt / live anchor | organizer-only ([scitt-hackathon.md](./scitt-hackathon.md) Appendix B) |

Real evidence to show without re-running: the **first live on-chain anchor
landed on Base Sepolia 2026-07-10** (tx `0x652dbf5a…`, see the publisher status
doc). Screenshot the basescan page for a slide.

---

## 3. Part 1 — Teaser (~90 s)

Two clips, three slides. One beat per property; no pipeline detail.

| # | Type | Content |
|---|------|---------|
| 1 | Slide | Title. "draft-bryce MMR profile → two properties: offline receipts, split-view protection." |
| 2 | Clip | **Offline receipts.** `pnpm --filter @forestrie/receipt-verify test` → green `ok`. Then flip a byte → the negatives suite rejects with a named stage/reason. VO: *bytes in, cryptographic verdict, no service contacted.* |
| 3 | Clip | **Split-view.** The accept-then-reject hero run (see [§6](#6-the-hero-split-view-clip-item-2-deferred-python)): first checkpoint **ACCEPT**, forked checkpoint **REVERT (`SizeMustIncrease`)**. |
| 4 | Slide | "Clone it, run these two commands yourself." Two Tier-A commands + draft link. |

---

## 4. Part 2 — Deep-dive (~5–7 min)

Walk the pipeline. Each section = one framing slide + one or two Tier-A clips.

1. **Receipt anatomy.** `pnpm --filter @canopy/scripts decode-receipt receipt.cbor`
   → COSE Sign1 + label-396 inclusion proof, payload = 32-byte peak.
   Slide: leaf = `SHA-256(idtimestamp_be8 ‖ grantCommitmentHash)`
   (`canopy/packages/libs/receipt-verify/src/leaf-commitment.ts:11`).
2. **Offline verify internals.** The five checks in
   `canopy/packages/libs/receipt-verify/src/verify-grant-receipt-offline.ts:96`
   (parse → genesis trust key → recompute leaf → verify peak signature → verify
   inclusion). Clip: the human CLI `verify-grant-receipt … → ok`; then the
   negatives run showing distinct `stage`/`reason` per failure
   (`canopy/packages/libs/receipt-verify/test/negatives.test.ts:17`).
3. **Checkpoints & the accumulator.** Slide: only the **TreeSize2 accumulator**
   is signed (ADR-0046, `arbor/services/_deps/go-merklelog/massifs/checkpointsign.go:104`);
   **peak receipts** are pre-signed so anyone can mint an inclusion receipt
   *without the signing key* (`…/mmriver.go:145`) — privacy, and the bridge to
   split-view via old-accumulator compatibility.
4. **Anchoring & split-view on-chain.** How `publishCheckpoint` forces a
   consistent extension of the *stored* accumulator + monotonic size + a
   signature over the contract-derived accumulator
   (`univocity/src/contracts/_Univocity.sol:155`, `:189`, `:815`). Clips:
   univocity rejection tests `-vvv`; arbor
   `TestBuildEmbeddedProofChainReBaseFirstAnchorAfterReseal`
   (`arbor/services/pkgs/publishproof/chain_test.go:157`) verifying the chain
   exactly as the contract does. Optional (Tier B / C footage): the anvil
   `publishCheckpoint` mine, and the real basescan tx.
5. **Why it composes / call to adopt.** Return to the thesis; show the
   repeatability tiers so the WG knows they can reproduce it.

---

## 5. Shot list — exact commands (Tier A unless noted)

Grounded, copy-paste, verified 2026-07-10.

**Offline receipts (canopy):**
```bash
# zero secrets, zero network — the offline-verify hero + tamper rejection
pnpm install
pnpm --filter @forestrie/receipt-verify test          # verify-grant-receipt-offline.test.ts + negatives.test.ts

# human-facing CLI on real artifacts (from scripts/, after you have the files):
pnpm --filter @canopy/scripts verify-grant-receipt \
  --genesis genesis.cbor --receipt receipt.cbor \
  --grant-b64 "$COMPLETED_GRANT_B64" --idtimestamp-be8 idts.be8   # prints: ok
pnpm --filter @canopy/scripts decode-receipt receipt.cbor          # structural view (label 396)
```

**Split-view protection (univocity, Foundry — zero secrets):**
```bash
cd univocity
forge test --match-test test_publishCheckpoint_revertsOnSizeDecrease -vvv          # rollback fork → SizeMustIncrease
forge test --match-test test_publishCheckpoint_revertsOnInvalidConsistencyProof -vvv  # divergent history → InvalidAccumulatorLength
forge test --match-contract UnivocityInvariantTest -vvv                            # fuzz: size never regresses
```

**Consistency / anchoring (arbor, Go):**
```bash
cd arbor/services/pkgs/publishproof
go test -run BuildEmbeddedProofChain ./...                     # Tier A: proof chain verified like the contract
go test -run TestDelegatedPublishFromSealedCheckpoint ./...    # Tier B: publishCheckpoint mined on local anvil (needs foundry/anvil; skips if absent)
```

**Live footage (Tier C, pre-record only):** full register→receipt→offline-verify
via `doppler run --project canopy --config dev -- task test:e2e:preflight` then
`task test:e2e` (`grants-bootstrap.spec.ts` asserts `verifyGrantReceiptOffline → ok`);
the Base Sepolia anchor tx `0x652dbf5a…`.

---

## 6. The hero split-view clip (item 2, deferred — Python)

No single test today publishes a valid checkpoint *then* a conflicting one in
one run; the accept and reject halves live separately in
`univocity/test/checkpoints/Univocity.t.sol` (`:371` accept-then-size-decrease,
`:503` accept-then-bad-proof). One command that shows **ACCEPT then REVERT** is
far stronger on camera. Per the request, build this driver in **Python**.

**Recommended shape — Python orchestrates, it does not re-implement crypto:**

```
demo/split_view.py   (web3.py + eth-account)
  1. start a fresh anvil (or `cd univocity && task anvil:start:local`)
  2. deploy Univocity from the compiled artifact in univocity/out/ (ABI + bytecode)
  3. bootstrap the root log
  4. publishCheckpoint(<consistent extension>)  -> assert receipt.status == 1, logState.size advanced   # ACCEPT
  5. publishCheckpoint(<forked: size-decrease OR wrong consistency proof>)
        -> expect web3 ContractLogicError; print the decoded revert (SizeMustIncrease / InvalidAccumulatorLength)  # REVERT
```

**Load-bearing constraint — do NOT port the checkpoint crypto to Python.** The
valid calldata (consistency proof + a signature over the TreeSize2 accumulator)
is non-trivial and already exercised by the Solidity/Go tests. Reimplementing it
in Python would duplicate load-bearing crypto and risk divergence. Instead,
**export the calldata blobs as fixtures** from the existing Foundry/Go tests
(the accept case and each reject case) to JSON, and have `split_view.py` just
*submit* them and narrate the outcome. Python owns orchestration + on-screen
narration; the tested code owns the bytes.

This keeps the clip repeatable (anvil + `out/` artifacts, no secrets) and the
verification authority unchanged.

> **Same principle for any Python offline-verify wrapper:** the real verifier is
> `@forestrie/receipt-verify` (TypeScript). If a Python narration wrapper is
> wanted, have it shell out to `pnpm … verify-grant-receipt` and pretty-print —
> do not re-implement COSE/MMR verification in Python.

---

## 7. Production checklist (deadline: Saturday)

- [ ] **Refresh the stale doc** (done alongside this plan — see
      [scitt-hackathon.md](./scitt-hackathon.md)) so nothing on screen contradicts the code.
- [ ] Build `demo/split_view.py` + export accept/reject calldata fixtures ([§6](#6-the-hero-split-view-clip-item-2-deferred-python)).
- [ ] Record Tier-A clips: offline-verify test, negatives, decode-receipt, forge rejection tests, arbor proof-chain test.
- [ ] Pre-record Tier-B/C footage: anvil `publishCheckpoint` mine; basescan anchor tx.
- [ ] Slides: thesis, receipt anatomy, accumulator/peak-receipts, on-chain enforcement, "run it yourself", adopt.
- [ ] Voiceover script; keep the teaser under 90 s.

---

## 8. Risks & honest caveats (say them, don't hide them)

- **`sign-statement` still does not exist.** `scripts/gen-cose-sign1.ts` is
  **legacy** (empty protected header, no `kid`) and does not satisfy the current
  statement contract; the canonical path is the library encoder
  `encodeCoseSign1Statement` in `@canopy/encoding`, not a CLI. So do **not**
  script a live "sign your own statement" beat for strangers — the offline-verify
  hero uses a self-generating fixture that needs no signing key from the viewer.
- **Full register→receipt is Tier C** (Doppler + testnet). Film it pre-provisioned;
  do not imply a stranger can run it live.
- **Arbor on-chain tests skip silently** without foundry/anvil on PATH — verify the
  toolchain before recording, or the anchor beat won't run.
- **Checkpoint MMR-root extraction from standalone checkpoint state is a TODO**
  (`canopy/packages/apps/canopy-api/src/scrapi/checkpoint-from-storage.ts:100`).
  Fine for receipt-based offline verify (uses the receipt's own peak+proof); do
  not build a beat on standalone checkpoint-state root extraction.
- **Multi-massif cross-massif catch-up is deferred** (plan-2607-09) — keep demo
  logs single-massif.

---

## 9. Open decisions

- Teaser length: hard 60 s vs ~90 s.
- Whether to show the anvil live-mine (Tier B) in the teaser or reserve it for the deep-dive.
- Slide tool / recording setup (out of scope here; affects only production, not content).
