# MMR interior-node position commitment fix + KAT parity

**Status:** DRAFT
**Date:** 2026-05-31
**Related:** [plan-0026](plan-0026-auth-data-log-parent-receipt-rca.md),
[plan-0024](plan-0024-byok-checkpoint-seal-rca.md),
[`@canopy/merklelog` algorithms](../../packages/merklelog/src/mmr/algorithms.ts),
go-merklelog `mmr/includedroot.go` + `mmr/draft_kat39_test.go`,
MMRIVER profile (`draft-bryce-cose-receipts-mmr-profile`) and reference
`algorithms.py`.

## Root cause (confirmed against the canonical reference)

The deployed log (go-merklelog, used by Ranger + sealer) and the MMRIVER profile
hash every interior MMR node as `H(pos_BE8 ‖ left ‖ right)`, where `pos` is the
1-based node position. The reference `included_root` walks the inclusion proof
applying `hash_pospair64(i+1, …)` at each step, and the receipt payload is
detached so the verifier MUST recompute this root.

[`packages/merklelog/src/mmr/algorithms.ts`](../../packages/merklelog/src/mmr/algorithms.ts)
`calculateRoot` walked the same path but hashed `H(left ‖ right)` with the `pos`
prefix omitted (it even tracked `currentPos` and never hashed it). So:

- `mmrIndex 0` (single leaf, empty proof, peak == leaf): no interior hash, works
  → BYOK e2e and all single-leaf paths passed, masking the bug.
- `mmrIndex ≥ 1`: reconstructed peak `H(l0 ‖ l1)` but the sealed/signed peak is
  `H(3_BE8 ‖ l0 ‖ l1)` → wrong detached payload → `verifyReceiptInclusionFromParsed`
  returns `signature-failed` → `auth-data-log-chain` 403.

Leaf hashing and grant commitment already matched Ranger
(`SHA-256(idTimestampBE8 ‖ contentHash)`), so the bug was solely the interior-node
position prefix. Existing `calculateRoot` tests were circular (toy XOR hasher,
verify against self) and never caught it.

## The fix

`calculateRoot` now advances `currentPos` to the parent's 1-based position and
commits it as the hash prefix, exactly mirroring go `IncludedRoot`:

- right child: `pos = pos + 1`, `root = H(pos ‖ sibling ‖ root)`
- left child: `pos = pos + (2 << height)`, `root = H(pos ‖ root ‖ sibling)`

A `u64BigEndian(Uint64)` helper encodes `pos` as 8 bytes big-endian (matching go
`HashWriteUint64` / Python `pos.to_bytes(8, "big")`). No worker logic changed
beyond the merklelog primitive; the receipt path consumes `calculateRoot`
directly via `receipt-verify.ts`.

## Work completed

### Phase 1 — reproduce then fix (hard gate)

- `packages/merklelog/test/mmr/calculate-root-kat.test.ts`: non-circular
  SHA-256 KAT asserting
  `calculateRoot(leaf1, [leaf0], mmrIndex=1) == SHA-256(u64be(3) ‖ leaf0 ‖ leaf1)`.
  Verified it **failed** pre-fix and **passes** post-fix.

### Phase 2 — confirm against the real verification path

- `packages/apps/canopy-api/test/multi-leaf-delegated-receipt.test.ts`: new case
  builds the signed detached peak the **go way**
  (`positionCommittedInteriorHash(3, leaf0, leaf1)` in
  `test/helpers/delegated-receipt-fixtures.ts`), **not** via `peakForLeafProof`
  (which uses `calculateRoot` and is therefore circular), and asserts
  `verifyReceiptInclusionFromParsed` → `ok`. Its peak-equality assertion is the
  same math as the Phase 1 gate, so it discriminates pre/post fix.

### Phase 3 — audit (coverage matrix + flags)

| Reference (go / algorithms.py) | TS function | Existing test | Status / gap |
|---|---|---|---|
| `included_root` / `hash_pospair64` | `algorithms.calculateRoot` | KAT + KAT39 parity (new) | **fixed**, pinned to golden hex |
| `verify_inclusion` | `algorithms.verifyInclusion` | KAT39 parity (new) | correct post-fix |
| `index_height` / `pos_height` | `math.heightIndex` | KAT39 parity (new) | correct |
| `mmr_index` | `index.mmrIndex`, `math.mmrIndexFromLeafIndex` | KAT39 parity (new) | correct |
| `leaf_count` == `PeaksBitmap` | `math.leafCount` | KAT39 parity (new) | **fixed** (was `(n+1)/2`) |
| `peaks` (accumulator) | — (none in merklelog) | KAT39 full-peaks (new) | gap: no exported `peaks`; duplicated privately in `resolve-receipt.ts` |
| consistency proof | `algorithms.verifyConsistency` | none | **stub, always true** — documented TODO |
| peak bagging | `algorithms.bagPeaks` | `algorithms.test.ts` (length only) | not position-committed, **unused** by receipt path — documented warning |
| `leaf_index` | `math.leafIndex` | none | not parity-tested; same bug class as old `leafCount` — flagged |

Flags actioned in code:

- `bagPeaks`: JSDoc warning — not spec-aligned for MMRIVER, not used by the
  receipt path, retained only for legacy callers.
- `verifyConsistency`: JSDoc warning — non-functional stub returning `true`
  unconditionally; must not be used for any trust decision (`TODO(plan-0027)`).
- `leafCount`: corrected to `PeaksBitmap(mmrSize)` (the naive `(n+1)/2` is only
  right for perfect/single-peak sizes; size 4 → 3 leaves, not 2). No worker
  consumers (the receipt path uses `resolve-receipt.ts`’s own peaks-bitmap copy).
- `calculateRoot` 4th param documented as an **MMR index** (not a leaf index)
  to avoid the latent `leafIndex`/`mmrIndex` confusion in `verifyInclusion`.

Consumer map: `receipt-verify.ts` (`verifyReceiptInclusion[FromParsed]`) is the
sole worker consumer of `calculateRoot`/`verifyInclusion` and the only path that
exercises interior hashing (`mmrIndex ≥ 1`). `resolve-receipt.ts` constructs
proofs and attaches pre-signed peak receipts; it does **not** call
`calculateRoot`, and maintains its own `peaks`/`peakIndex`/`inclusionProof`
copies (internal duplication between `resolveReceipt` and `buildReceiptForEntry`,
plus leftover `console.log` diagnostics — noted for a future cleanup, not part of
this fix).

### Phase 4 — known-answer parity suite

- `packages/merklelog/test/helpers/sha256-hasher.ts`: real SHA-256 hasher +
  hex helpers, replacing the toy XOR `TestHasher` in `algorithms.test.ts`.
- `packages/merklelog/test/mmr/kat39-parity.test.ts`: golden vectors copied
  verbatim from go-merklelog `draft_kat39_test.go` (21 leaves, full 39-node hash
  table, leaf MMR indices, complete-MMR sizes, full-MMR peaks). Tests:
  - `add_leaf_hash` reconstructs the full 39-node table (faithful builder,
    independent of `calculateRoot`).
  - `index_height` for all 39 nodes + go `TestIndexHeight` spot cases.
  - `mmr_index(leafIndex)` and `leaf_count(mmrSize)` tables.
  - full-MMR accumulator peaks match the golden hashes.
  - `calculateRoot` + `verifyInclusion` reproduce the covering peak for **every**
    one of the 39 nodes (covers `mmrIndex 0` and ≥ 1, leaves and interior).
  - `verifyInclusion` rejects a tampered peak.

## Verification status

- [x] `pnpm --filter @canopy/merklelog test` — 194 passing (incl. KAT + KAT39).
- [x] `pnpm --filter @canopy/api test` — 172 passing / 3 skipped.
- [x] `pnpm --filter @canopy/api typecheck` and `@canopy/merklelog` typecheck clean.
- [x] Prettier clean on all files changed here.
- [x] Dry-run build of `canopy-api` succeeds (`wrangler deploy --dry-run`).
- [x] Deployed `canopy-api` to **dev** (`canopy-api-dev`, version
  `e2cefb47-56df-419b-96bf-b166f0ade250`) — the fix is live; merklelog is bundled.
- [ ] `auth-data-log-chain` (system e2e) green + BYOK stretch. **Blocked locally**
  by the documented Custodian **401** (`valid app token required`): the runner
  fails in `beforeAll` at `postCustodianCreateEs256Key` (minting the bootstrap
  grant), **before** the `register-grant` path that exercises `calculateRoot`.
  This is the same local credential blocker recorded in plan-0026; **CI** (with a
  valid `CUSTODIAN_APP_TOKEN`) is the integration source of truth and should be
  used to confirm green after this change lands. The offline KATs reproduce the
  exact failure mode and pass post-fix, so the e2e is expected to flip green.

## Scope / risk notes

- `@canopy/merklelog` is shared; behavioural changes are `calculateRoot` (now
  spec-correct) and `leafCount` (now spec-correct). `bagPeaks`/`verifyConsistency`
  were only annotated, not behaviourally changed.
- Pre-existing, unrelated working-tree state: `delegation-coordinator`
  (`package.json`, `wrangler.jsonc`, and a `byok-material-fixture.ts` typecheck
  error) and several already-unformatted files were left untouched.
