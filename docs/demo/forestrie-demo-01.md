# Zero to Hero

## Demo questions answered

1. How do I register a signed statement ?
2. How is split view protection enforced for a log ?
3. How do I keep control over my checkpoint signing key ?
4. If I stop trusting the forestrie operator how do I carry on independently ?

"With a forestrie hosted sealer you are trusting the sealer to sign on your
behalf for a time limited and usage (registration) limited bounded period. No
revocation, just keep that delegation grant short"

"Self hosted sealing is easy if direct checkpoint signing without
delegation is a requirement"


## Open questions

1. Does using ES256 complicate any demo flows or specific demo items ?
2. Does it make sense to make a single client tool that imports packages from
   canopy, univocity-tools and mandate and complies to a static executable
using bun following the patterns established by univocity-tools for bun cli
tools ?
3. Can we use playwrite with mandate to record the deployment demo ?
4. Is there a slick way to demo multi-sign safe without significantly
   complicating or confusing the demo ? Ie a safe with a 1 of n and my
fupduck.eth as the 1 ?
5. How can we ensure that each individual demo emphasises the benefits of
   SCITT, COSE-Receipts ?
6. Is it a distraction to talk about forestrie in general: ie "its a pipe not a
   store"
7. Does it make sense to start in the "midle", ie do register statement first,
   and treat the authorization header as "we will explain this in later steps"

   ie considering the items below do  we:
    1. show basic registration
    2. then show auth log granting more signers in same data log
    3. then show univocity bootstrap
    4. then show self-serve receipts
    5. then show that self-serve receipts + the last massif makes moving to a
       new operator trivial

    Or do we start with univocity bootstrap and build up through register-grant
    to register-signed-statement ?

### Answers

1. **ES256 — no, it simplifies.** ES256 is the paved path end-to-end: the
   deployer supports `--bootstrap-alg es256`, the e2e suite runs ES256
   bootstrap (plan-0032 dev deployment), statement `kid` binding is the first
   32 bytes of x||y, and `@forestrie/receipt-verify` verifies **ES256 only**
   for receipt signatures (`es256ReceiptVerifyKeys`, error
   `no_es256_trust_key`). The one place ES256 *cannot* go is the Safe /
   multisig story (Q4 of open question 4): a Safe is an address, so that
   segment needs a **KS256** bootstrap (ERC-1271 path). Recommendation: run
   the core register→receipt→exit arc entirely ES256; do the Safe aside on a
   separate, pre-provisioned KS256 deployment; never switch algorithms inside
   one log hierarchy mid-demo.

2. **Single bun static client — yes, and the pattern is ready.**
   univocity-tools already establishes it: citty CLI with parse/execute
   split (`docs/agents/cli.md`), cross-platform static binaries via
   `Bun.build({ compile })` (`scripts/build-binary.ts`), and importable
   libraries (`@univocity-tools/deployer-common`, browser-safe
   `deploy-core`). The friction is on the canopy side: `@canopy/encoding`
   and `@forestrie/receipt-verify` are workspace-private, so the demo CLI
   needs them published (tarball or git dep) or built inside the canopy
   workspace. Recommendation: one `forestrie` binary with subcommands
   `deploy`, `sign-statement`, `register`, `create-receipt`,
   `complete-grant`, `verify` — that list is exactly the current
   participant-facing CLI gaps, so the tool and the demo converge.

3. **Playwright + mandate — yes, mostly built.** Mandate has hermetic
   Playwright e2e with a Privy mock and a burner-wallet config
   (`packages/tests/ui-e2e/playwright.config.ts`,
   `playwright.burner.config.ts`, `burner-sign-submit.spec.ts`). Caveat: the
   browser deploy flow is NOT a mandate page — it is
   `univocity-tools/apps/deploy-web` (univocity-deploy.pages.dev; FORKING.md
   path B′). Recommendation: add a small Playwright spec to univocity-tools
   for deploy-web (reusing mandate's Privy mock/burner seam) and record with
   `video: 'on'`; record the mandate delegation-console segment from its
   existing specs. Burner wallet avoids browser-extension automation pain.

4. **Multisig Safe — slick as a pre-provisioned aside, confusing live.**
   The machinery exists: KS256 `rootKey` is an address and the contract
   verifies via ERC-1271 (plan-0031 already deployed with a Root Safe on
   Base Sepolia). Recommendation: 60 seconds, no live Safe administration —
   show `logConfig(logId).rootKey` equals the Safe address on-chain, have
   fupduck.eth (the 1 of n) sign the one action, and land the line "the
   bootstrap identity can be your org's signing policy, not a person's
   laptop". Anything more steals time from the receipt story.

5. **Per-demo SCITT/COSE-Receipts emphasis — one receipt property per
   step, same closer.** Registration → "any SCRAPI client, plain COSE
   Sign1". Receipt → "COSE receipt: Sign1 + MMR inclusion, decode it live
   with `decode-receipt` so the audience sees it's just COSE". Self-serve →
   "receipts are *derivable from the data*; the API endpoint is a
   convenience, not an authority". Chain anchor → "split-view protection is
   a contract invariant, not operator behaviour". Close every step by
   running the SAME offline verifier — repetition of one verify command is
   the message.

6. **"Pipe not store" — one sentence, then prove it.** Say it once up
   front, never argue it. Steps 4–5 of the ordering below *are* the
   demonstration: self-created receipts and the operator-exit finale make
   the point concretely; the slogan lands as the closing line of the exit
   step, not as theory in the middle.

7. **Start in the middle — yes.** Register a statement first with the
   grant header treated as an opaque bearer credential ("explained later"),
   exactly as scitt-hackathon.md already sequences it. The proposed order
   (registration → more signers → univocity bootstrap → self-serve receipts
   → operator exit) maps cleanly onto the "demo questions answered": Q1 is
   answered in the first five minutes, Q2 lands with the bootstrap/chain
   step, Q3 with delegation bounds, and Q4 is the finale — self-serve
   receipts + last massif = walk away. Bootstrap-first spends the
   audience's freshest attention on the hardest, least SCITT-specific
   material; middle-first gets a verifiable receipt into their hands before
   any chain talk. Architecture note (verified in `register-grant.ts`): a
   grant binds exactly ONE signer (`grantData`), and several signers on one
   data log means several grants each naming that log — the grant leaves are
   sequenced into the OWNER (auth) log (`enqueueAndStoreGrant` targets
   `ownerLogId`), the data log holds only statements, and no uniqueness
   constraint applies to post-creation grants (univocity's 409 gates only
   the creation grant). So step 2's demo line is "one grant per signer, all
   targeting the same data log, all recorded in the auth log".

---

# Demo runbook (Zero to Hero)

> **Purpose (dual):** (1) a *talk outline* for the IETF SCITT WG MMR-profile
> adoption call, and (2) a *runnable script* an agent session can execute
> end-to-end to exercise the `forestrie` CLI. Every step names the target
> `forestrie` subcommand **and** a "run-it-today" fallback so the doc is
> testable before the binary lands.
>
> **Initiative:** [MMR Profile Adoption Call Demo](https://linear.app/forestrie/initiative/mmr-profile-adoption-call-demo-3822bf4c5af7).
> Steps map to project **forestrie CLI: Zero-to-Hero demo** (FOR-354, FOR-355,
> FOR-356, FOR-334, FOR-290); subcommands to **forestrie CLI: binary &
> commands** (FOR-339…FOR-347); importable substrate to **forestrie CLI: public
> packages** (FOR-336, FOR-348…FOR-353).
>
> **Narrative order = start in the middle** (Answer 7): register first, reveal
> the bootstrap later. **Execution order ≠ narrative order** — the live
> instance is *pre-provisioned in rehearsal* (§ Pre-flight) so that on stage we
> can open with a verifiable receipt in the audience's hands before any chain
> talk. Step 3's deploy is shown from the **recorded Playwright clip** (FOR-355),
> not run live.
>
> **Paved path: ES256 end-to-end. Never switch algorithms inside one log
> hierarchy mid-demo** (Answer 1). KS256 appears only in the pre-provisioned
> Safe aside.

## The single closer (repeat it every step)

Every step ends by running the **same** offline verifier — repetition is the
message (Answer 5):

```bash
forestrie verify --genesis genesis.cbor --receipt receipt.cbor --grant-b64 "$GRANT_B64"
# → ok            (exit 0)
# tamper one byte of receipt.cbor → non-zero exit, "verify failed: stage=… reason=…"
```

Run-it-today fallback (FOR-290; the CLI now owns this, replacing the bespoke
script):

```bash
pnpm --filter @canopy/scripts verify-grant-receipt \
  --genesis genesis.cbor --receipt receipt.cbor \
  --grant-b64 "$GRANT_B64" --idtimestamp-be8 idts.be8
```

---

## Pre-flight (rehearsal — run BEFORE the talk)

Goal: stand up a live ES256 univocity instance and provision one root grant, so
the on-stage "start in the middle" opening has something to register against.
Also captures the artefacts every later step consumes.

### Prerequisites

- `forestrie` binary on `PATH` (FOR-339: `bun run build:binary` → single static
  binary), **or** run from source in the canopy workspace with `pnpm`.
- Base Sepolia funded deployer key (or a burner via the deploy-web/Privy path).
- A checkout of `univocity-tools` (for `forestrie deploy`, which wraps
  `@univocity-tools/deploy-core`).
- `jq`, `curl`, `cast` (foundry) for the manual/fallback paths.

### Canonical environment (export once; every step reads these)

```bash
export FORESTRIE_BASE_URL="https://api-b-forest-2.forestrie.dev"   # SCRAPI worker origin, no trailing slash (== CANOPY_BASE_URL)
export RPC_URL="https://sepolia.base.org"
export CHAIN_ID=84532                                              # Base Sepolia
# Filled in by the deploy step below:
export UNIVOCITY_ADDRESS=                                          # 0x… ImutableUnivocity contract
export BOOTSTRAP_LOG_ID=                                           # root/bootstrap log UUID (derived from UNIVOCITY_ADDRESS)
# Signing keys (ES256 P-256 PKCS#8 PEM):
export BOOTSTRAP_PEM=./bootstrap.es256.pem                        # the deploy bootstrap key (root grant signer)
export ALICE_PEM=./alice.es256.pem
export BOB_PEM=./bob.es256.pem
```

### R1 — Deploy a univocity instance (ES256)  ·  subcommand `forestrie deploy` (FOR-340)

```bash
forestrie deploy \
  --bootstrap-alg es256 \
  --bootstrap-es256-generate --bootstrap-es256-pem-out "$BOOTSTRAP_PEM" \
  --owner-address 0xYOUR_DEPLOYER \
  --rpc-url "$RPC_URL" \
  --out deployment.json
# stdout / deployment.json → { imutableUnivocity, genesisLogId, bootstrapAlg: "es256", chainId }
export UNIVOCITY_ADDRESS=$(jq -r .imutableUnivocity deployment.json)
export BOOTSTRAP_LOG_ID=$(jq -r .genesisLogId    deployment.json)
```

Run-it-today fallback (raw univocity-tools deployer — propose + execute):

```bash
cd univocity-tools
./apps/deployer/dist/deployer deploy propose imutable \
  --bootstrap-alg es256 \
  --bootstrap-es256-generate --bootstrap-es256-pem-out "$BOOTSTRAP_PEM" \
  --owner-address 0xYOUR_DEPLOYER --rpc-url "$RPC_URL" \
  --out proposal.json
./apps/deployer/dist/deployer deploy execute proposal.json \
  --owner-signer 0xDEPLOYER_PRIVKEY --rpc-url "$RPC_URL"
# verify on-chain bootstrap key:
cast call "$UNIVOCITY_ADDRESS" "bootstrapConfig()(int64,bytes)" --rpc-url "$RPC_URL"
```

### R2 — Fetch the public genesis (cache it; verification is offline forever after)

```bash
curl -sS "$FORESTRIE_BASE_URL/api/forest/$BOOTSTRAP_LOG_ID/genesis" -o genesis.cbor
curl -sS "$FORESTRIE_BASE_URL/.well-known/scitt-configuration" | jq .   # sanity: discovery works
```

### R3 — Mint + register the root grant (bootstrap leaf is self-referential)

The first leaf in the root log is allowed to be self-referential
(`logId == ownerLogId`) precisely because the signer is the bootstrap public
key bound to the contract at deploy time. This yields `ROOT_GRANT_B64`, the
opaque bearer credential the on-stage opening treats as "explained later".

```bash
forestrie register-grant \
  --base-url "$FORESTRIE_BASE_URL" \
  --owner-log "$BOOTSTRAP_LOG_ID" --data-log "$BOOTSTRAP_LOG_ID" \
  --sign-with "$BOOTSTRAP_PEM" \
  --self-referential \
  --out-b64 root-grant.b64
export ROOT_GRANT_B64=$(cat root-grant.b64)
```

Run-it-today fallback: e2e-kit `bootstrapMintAndRegisterEnqueued` /
`completeBootstrapGrantWithReceipt`
(`packages/tests/e2e-kit/src/bootstrap-grant-flow.ts`) — mint, `POST
/register/$BOOTSTRAP_LOG_ID/grants` with `Authorization: Forestrie-Grant …`,
poll the 303 status URL to the `/receipt` redirect, then
`buildCompletedGrantBase64`.

**Rehearsal artefacts now on disk:** `deployment.json`, `genesis.cbor`,
`bootstrap.es256.pem`, `root-grant.b64`. Keep them; the talk consumes them.

---

# The talk (narrative order)

## Opening line (say once, then prove it — Answers 6)

> "Forestrie is a **pipe, not a store**." — don't argue it; Steps 4–5 are the proof.

---

## Step 1 — Register a signed statement  ·  Q1 · ~4 min

**Talking point:** get a verifiable receipt into the audience's hands before any
chain talk. The `Authorization: Forestrie-Grant …` header is an **opaque bearer
credential** here — "we'll explain where it comes from in a moment."

**SCITT emphasis (Answer 5):** "any SCRAPI client, plain COSE Sign1."

**Setup / prereqs:** § Pre-flight complete. Have `$FORESTRIE_BASE_URL`,
`$BOOTSTRAP_LOG_ID`, `$ROOT_GRANT_B64`, `$ALICE_PEM`, `genesis.cbor`.

**1a. Sign a statement** — subcommand `forestrie sign-statement` (FOR-341).
`kid` = first 32 bytes of `x||y` under ES256.

```bash
echo '{"claim":"hello scitt wg","ts":"2026-07-11"}' > statement.json
forestrie sign-statement \
  --key "$ALICE_PEM" \
  --payload statement.json --content-type application/json \
  --out statement.cose
```

**1b. Register it** — subcommand `forestrie register` (FOR-342). Posts the plain
COSE Sign1 with the grant header, follows the 303, polls, downloads the receipt.

```bash
forestrie register \
  --base-url "$FORESTRIE_BASE_URL" \
  --log-id "$BOOTSTRAP_LOG_ID" \
  --statement statement.cose \
  --grant-b64 "$ROOT_GRANT_B64" \
  --out receipt.cbor
export GRANT_B64="$ROOT_GRANT_B64"
```

Run-it-today fallback (exact SCRAPI curl, from `scitt-hackathon.md` §4–6):

```bash
curl -sS -D headers.txt -o /dev/null -X POST \
  "$FORESTRIE_BASE_URL/register/$BOOTSTRAP_LOG_ID/entries" \
  -H "Authorization: Forestrie-Grant $ROOT_GRANT_B64" \
  -H 'Content-Type: application/cose; cose-type="cose-sign1"' \
  --data-binary @statement.cose
STATUS_URL=$(grep -i '^location:' headers.txt | cut -d' ' -f2- | tr -d '\r')
while :; do curl -sS -D h.txt -o /dev/null "$STATUS_URL"
  LOC=$(grep -i '^location:' h.txt | cut -d' ' -f2- | tr -d '\r')
  case "$LOC" in */receipt) curl -sS "$LOC" -o receipt.cbor; break;; esac; sleep 1; done
```

**Close:** run **the single closer** (`forestrie verify … → ok`).

---

## Step 2 — Authorize several signers on a data log  ·  Q1 (auth) · ~5 min

**Talking point:** SCITT's authorization requirement, realised as a **hierarchy
of forestrie logs** — each log is its own sequence of signed statements.
`register-grant` is just a helper around `register-signed-statement`: it
registers a statement that authorizes use of a child/data log.

**Architecture line (Answer 7, verified in `register-grant.ts`):** "one grant
per signer, all targeting the same data log, all recorded in the auth log." A
grant binds exactly ONE signer (`grantData`); grant leaves are sequenced into
the **owner/auth** log (`enqueueAndStoreGrant → ownerLogId`); the **data** log
holds only statements. No uniqueness constraint on post-creation grants (the
409 gates only the *creation* grant).

**SCITT emphasis:** delegation is itself a transparent, receipted statement.

**Setup / prereqs:** Step 1 done. Choose `AUTH_LOG_ID` (a child auth log under
root) and `DATA_LOG_ID` (a data log under that auth log).

```bash
export AUTH_LOG_ID=$(uuidgen | tr 'A-Z' 'a-z')
export DATA_LOG_ID=$(uuidgen | tr 'A-Z' 'a-z')
```

**2a. Create the child auth log** (bootstrap-shaped grant, signed by the root
key, parent grant supplied in the body):

```bash
forestrie register-grant \
  --base-url "$FORESTRIE_BASE_URL" \
  --owner-log "$BOOTSTRAP_LOG_ID" --data-log "$AUTH_LOG_ID" \
  --auth-log \
  --sign-with "$BOOTSTRAP_PEM" \
  --parent-grant-b64 "$ROOT_GRANT_B64" \
  --out-b64 auth-grant.b64
```

**2b. Grant Alice and Bob on the same data log** — subcommand
`forestrie register-grant` (FOR-343). One grant per signer, both naming
`$DATA_LOG_ID`, both recorded in `$AUTH_LOG_ID`:

```bash
for who in ALICE BOB; do
  pem_var="${who}_PEM"
  forestrie register-grant \
    --base-url "$FORESTRIE_BASE_URL" \
    --owner-log "$AUTH_LOG_ID" --data-log "$DATA_LOG_ID" \
    --signer-pem "${!pem_var}" \
    --parent-grant-b64 "$(cat auth-grant.b64)" \
    --sign-with "$BOOTSTRAP_PEM" \
    --out-b64 "grant-${who,,}.b64"
done
```

Run-it-today fallback: e2e-kit `signChildGrantUnderRoot` +
`completeGrantRegistrationThroughReceipt`
(`packages/tests/e2e-kit/src/register-grant-through-receipt.ts`); `grantData` =
the signer's ES256 `x||y` via `grantData64FromCustodianPem`.

**2c. Each signer registers a statement to the data log** — reuse
`forestrie sign-statement` + `forestrie register` from Step 1, now with
`--log-id "$DATA_LOG_ID"` and `--grant-b64 "$(cat grant-alice.b64)"` /
`grant-bob.b64`.

**Close:** run **the single closer** for each new receipt.

---

## Step 3 — Where did that grant come from? Univocity bootstrap  ·  Q2 · ~4 min

**Talking point:** now pay off the "explained later." The opaque bearer from
Step 1 is a **self-referential bootstrap grant**: the first leaf of the root
log, valid because its signer is the bootstrap public key **bound to the
univocity contract at deploy time**. Split-view protection is a **contract
invariant, not operator behaviour**.

**SCITT emphasis (Answer 5):** "split-view protection is a contract invariant."

**Presentation:** play the **recorded Playwright clip** (FOR-355) of the
browser deploy via `deploy-web` (`univocity-deploy.pages.dev`), narrating over
it — burner wallet, "Privy is the example web3 wallet." Do **not** deploy live;
the live instance was provisioned in § Pre-flight. Optionally show the mandate
delegation-console clip here.

**Testable equivalent (what the clip records):** § Pre-flight **R1**
(`forestrie deploy --bootstrap-alg es256`). To prove the binding on stage:

```bash
cast call "$UNIVOCITY_ADDRESS" "bootstrapConfig()(int64,bytes)" --rpc-url "$RPC_URL"
# int64 alg == -7 (ES256); bytes == the bootstrap x||y that signed root-grant.b64
```

**Close:** re-run **the single closer** on the Step 1 receipt — same command,
now the audience understands the grant it verifies.

---

## Step 4 — Self-serve receipts (the pipe, not the store)  ·  Q4 build-up · ~5 min

**Talking point:** receipts are **derivable from the data**; the API endpoint is
a convenience, not an authority. A client holding the massif `.log` blob and a
checkpoint rebuilds the leaf→peak inclusion path itself. Sound because the
checkpoint signature covers only the **accumulator**; paths are unsigned and
recomputable (same property as the arbor publisher rebuild fix, PR #38).

**SCITT emphasis (Answer 5):** "COSE receipt: Sign1 + MMR inclusion — decode it
live so the audience sees it's just COSE."

**Setup / prereqs:** the log's massif blob and checkpoint. Fetch them (or reuse
what the operator served in Step 1):

```bash
curl -sS "$FORESTRIE_BASE_URL/api/forest/$DATA_LOG_ID/massifs/0.log" -o massif.log
curl -sS "$FORESTRIE_BASE_URL/api/forest/$DATA_LOG_ID/checkpoint.sth" -o checkpoint.sth
```

**4a. Self-create the receipt — no operator call** — subcommand
`forestrie create-receipt` (FOR-345 / FOR-334). Attaches the locally-rebuilt
path to the pre-signed peak receipt from a format-v3 checkpoint, producing bytes
**identical to an API-issued receipt**:

```bash
forestrie create-receipt \
  --massif massif.log --checkpoint checkpoint.sth \
  --mmr-index 0 \
  --out receipt.selfserve.cbor
```

Run-it-today fallback (worktree `robin/for-334-create-receipt`):

```bash
pnpm --filter @canopy/scripts create-receipt \
  --massif massif.log --checkpoint checkpoint.sth \
  --mmr-index 0 --out receipt.selfserve.cbor
```

**4b. Self-create the grant header from a checkpoint** — subcommand
`forestrie complete-grant` (FOR-344). Given only the log's checkpoint (and an
idtimestamp), recreate the `Authorization: Forestrie-Grant` header content —
grants are derivable from log data, not operator-issued:

```bash
forestrie complete-grant \
  --grant grant-alice.b64 \
  --checkpoint checkpoint.sth --massif massif.log \
  --out-b64 grant-alice.completed.b64
```

**4c. Decode it live** — subcommand `forestrie decode-receipt` (FOR-346). Show
it's just COSE (Sign1 + MMR inclusion):

```bash
forestrie decode-receipt receipt.selfserve.cbor
```

Run-it-today fallback: `pnpm --filter @canopy/scripts decode-receipt receipt.selfserve.cbor`.

**Close:** run **the single closer** on `receipt.selfserve.cbor` — a receipt the
operator never issued verifies identically. *That* is the pipe.

**Why this matters — say it here, it sets up Step 5.** Be precise about *what*
verification is doing, because there are two modes and the audience will notice:

- **Offline against the cached checkpoint** (this step's closer): the verifier
  checks the receipt's COSE signature against the trusted ES256 sealer key
  **and** recomputes the peak from the inclusion path. The reason you can cache
  that checkpoint **forever, with no revocation machinery**, is that the sealer
  key was gatekept **by the contract at publish** — a split view is a contract
  violation, not a trust assumption.
- **Chain-anchored** (Step 5a): verification **collapses to just recomputing the
  peak from the nodes** and checking it is in the on-chain accumulator. You drop
  the signature check entirely — *because the checkpoint signer, and therefore
  the signer of every receipt, was already verified by the contract on publish*.
  Trust reduces to the contract.

That is the bridge: Step 4 = "verify offline against a checkpoint you keep
forever"; Step 5 = "…and you don't even need the signature — recompute the peak
against what the contract accepted."

---

## Step 5 — Operator exit: self-serve receipts + last massif = walk away  ·  Q3/Q4 finale · ~4 min

**Talking point (Q4 finale):** if you stop trusting the forestrie operator, you
carry on independently. You need nothing from them: the **last massif blob** +
the **on-chain checkpoint** are enough to keep issuing and verifying receipts
forever. Q3 (control of your signing key) is answered by the delegation bounds —
"a hosted sealer is a short, usage-bounded delegation; self-hosted direct
signing needs no delegation at all."

**SCITT emphasis (Answer 5):** verify against the accumulator published on-chain;
the client need only produce a path to an accumulator peak.

**Setup / prereqs:** `massif.log`, `genesis.cbor`, a receipt, `$UNIVOCITY_ADDRESS`,
`$RPC_URL`.

**5a. Verify a computed peak against the on-chain accumulator** — the
chain-anchored `forestrie create-receipt` variant (FOR-334 variant B); no
operator, only the contract:

```bash
forestrie create-receipt \
  --massif massif.log --mmr-index 0 \
  --univocity "$UNIVOCITY_ADDRESS" --log-id "$DATA_LOG_ID" --rpc-url "$RPC_URL"
# → chain-anchored: ok — computed peak i/n matches on-chain accumulator at size N
```

Fallback / raw read: `cast call "$UNIVOCITY_ADDRESS" "logState(bytes32)(bytes32[],uint64)" <log-id-bytes32> --rpc-url "$RPC_URL"`
(returns `(accumulator, size)`; signature enforced at publish, not stored — note
the lag caveat).

**5b. The whole audience verifies, offline, forever** — run **the single closer**
one last time. Land the closing line:

> "Consistency lets you cache this checkpoint forever; the accumulator only
> buries a peak after 2× more leaves, so you read new nodes rarely — and there's
> a decade of Merkle-log infrastructure to help. **It's a pipe, not a store.**"

---

## Aside — Multisig Safe root (pre-provisioned, ≤60s)  ·  FOR-356 · optional

**Off the ES256 arc — KS256 only.** Do not switch algorithms inside the core
hierarchy; this runs on a **separate, pre-provisioned KS256 deployment**
(plan-0031 Root Safe on Base Sepolia).

```bash
cast call "$KS256_UNIVOCITY_ADDRESS" "logConfig(bytes32)(...)" <log-id> --rpc-url "$RPC_URL"
# rootKey == the Safe address (ERC-1271); fupduck.eth (the 1-of-n) signs one action
```

**Line to land:** "the bootstrap identity can be your org's signing policy, not a
person's laptop." No live Safe administration.

---

## Step → demo-question map (for rehearsal QA)

| Step | Answers | Subcommands exercised | Linear |
|------|---------|-----------------------|--------|
| Pre-flight | setup | `deploy`, `register-grant` | FOR-340, FOR-343 |
| 1 Register | Q1 | `sign-statement`, `register`, `verify` | FOR-341/342/347 |
| 2 More signers | Q1 (auth) | `register-grant`, `sign-statement`, `register`, `verify` | FOR-343 |
| 3 Bootstrap | Q2 | (recorded `deploy`) + `verify` | FOR-340, FOR-355 |
| 4 Self-serve | Q4 build | `create-receipt`, `complete-grant`, `decode-receipt`, `verify` | FOR-334/344/345/346 |
| 5 Operator exit | Q3, Q4 | `create-receipt` (chain), `verify` | FOR-347 |
| Safe aside | Q4 open-4 | (KS256, read-only) | FOR-356 |

## Tooling status (what an agent can run today)

| `forestrie` subcommand | Status | Run-it-today fallback |
|---|---|---|
| `deploy` | planned (FOR-340) | `apps/deployer/dist/deployer deploy propose\|execute` |
| `sign-statement` | planned (FOR-341) | library `encodeCoseSign1Statement` (`@canopy/encoding`) |
| `register` | planned (FOR-342) | SCRAPI curl (§ Step 1 fallback) / e2e-kit register client |
| `register-grant` | planned (FOR-343) | e2e-kit `signChildGrantUnderRoot` + `completeGrantRegistrationThroughReceipt` |
| `complete-grant` | planned (FOR-344) | e2e-kit `buildCompletedGrantBase64` |
| `create-receipt` | in progress (FOR-334/345) | `pnpm --filter @canopy/scripts create-receipt` (worktree `robin/for-334-create-receipt`) |
| `decode-receipt` | planned (FOR-346) | `pnpm --filter @canopy/scripts decode-receipt` |
| `verify` | planned (FOR-347) | `pnpm --filter @canopy/scripts verify-grant-receipt` |

Substrate packages the CLI imports (must be published unauth to npmjs.org,
MIT-per-package, FOR-348): `@canopy/encoding` (FOR-349, done),
`@forestrie/receipt-verify` → receipt build+verify (FOR-353),
`@forestrie/grant-builder` (FOR-350), register client (FOR-351),
`@forestrie/custodian-client` (FOR-352).
