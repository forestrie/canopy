# Zero to Hero — demo outline

Presentation outline for the IETF SCITT WG MMR-profile adoption call. Each
section is one slide: the on-screen bullets, the speaker notes, the
`forestrie` command it runs, and example output.

**Status legend** — the state of the referenced `forestrie` subcommand:

- **exists** — implemented and runnable
- **tested** — implemented and exercised end-to-end (has passing tests)
- **tbd** — not yet implemented

The CLI is [`forestrie/forestrie-cli`](https://github.com/forestrie/forestrie-cli)
(binary `forestrie`, v0.1.0). Statuses below were verified against a local build
at commit `a955213` on 2026-07-12: `bun test` passes, and every subcommand was
run directly (offline paths against real emitted fixture artefacts). It installs
and runs tokenless — all `@forestrie/*` substrate packages (`grant-builder`,
`receipt-verify`, `scrapi-client`, `merklelog`, `encoding`) are already
published to public npm.

Most subcommands are implemented and tested, including `complete-grant`
(FOR-344, landed 2026-07-12) and `create-receipt`'s chain-anchored (report-only)
mode. Two authority verbs — **`create-log`** and **`delegate`** — are **tbd**
(FOR-390,
[plan-2607-21](https://github.com/forestrie/devdocs/blob/main/plans/plan-2607-21-cli-authority-commands-demo.md);
taxonomy in
[ADR-0052](https://github.com/forestrie/devdocs/blob/main/adr/adr-0052-cli-authority-taxonomy.md)).
This outline is their acceptance script — the beats below are exactly what they
must run against lane-A.

**Personas** (each exercises one authority — see ADR-0052): **Robert** holds
`K(root)` (deploys, creates David's auth log, delegates the root); **David**
holds `K(David-auth)` + `K(David-data)` (creates his data log, authorizes
writers, delegates his two logs); **Alice / Bob** are statement writers only
(never create, never delegate).

Example outputs marked **real capture** were taken from a direct run against
`main`. Outputs marked **illustrative** are for the network/chain paths
(`deploy`, `register`, `register-grant`, and the live chain reads) that need a
live SCRAPI worker / RPC endpoint — their *format* matches the CLI's real
reporter, but the values are placeholders to refresh during rehearsal.

> Paved path: **ES256 end-to-end**. Never switch algorithms inside one log
> hierarchy mid-demo. KS256 appears only in the pre-provisioned Safe aside.

---

## The single closer (run at the end of every step)

Every step ends by running the **same** offline verifier — the repetition is
the message.

**Why the repetition carries weight — the distinguishing
[MMR-profile](https://github.com/robinbryce/draft-bryce-cose-receipts-mmr-profile/blob/main/draft-bryce-cose-receipts-mmr-profile.md)
property:** each receipt signs an **accumulator peak (member)** — which covers
many leaves and stays valid as the log keeps growing — rather than a **single
tree head**, which binds just one state of the log. Three supportable one-liners
to draw on — *one per step, never all at once*:

- **the same receipt proves many nodes** — a signed peak attests every leaf in its subtree;
- **a receipt can be obtained without revealing the node of interest** — the checkpoint is over the whole accumulator, so inclusion is proved locally without telling the operator which entry you care about;
- **a receipt can be obtained later, or self-served** — pre-signed peaks stay valid; a buried peak is still reachable via "old-accumulator" consistency (an inclusion path to a current peak).

It is this same peak-signing property that lets **on-chain accumulator
verification stand in for receipt-signature verification** (Step 5). Contrast: a
tree head signs a *single* state of the log, so it speaks only to that snapshot;
an accumulator's signed peaks cover many leaves and keep proving inclusion as
the log grows — the same signature stays useful forever.

**Status:** `verify` — **exists / tested** (FOR-347, `verify.test.ts`)

```bash
forestrie verify \
  --genesis genesis.cbor --receipt receipt.cbor --committed-grant "$GRANT_B64"
```

Example output (**real capture** — offline verify of a good receipt, then a
tampered one):

```
verify: parse     ok      — receipt COSE decodes; genesis trust root loads (ES256)
verify: signature ok      — checkpoint signature verifies under the genesis trust key
verify: inclusion ok      — proof path recomputes the checkpoint peak
verify: binding   ok      — leaf binds the grant commitment at the receipt idtimestamp
PASS: receipt verified offline against the cached checkpoint

# tamper one byte of the receipt signature and re-run → exit 1:
verify: parse     ok      — receipt COSE decodes; genesis trust root loads (ES256)
verify: signature failed  — signature_invalid
verify: inclusion skipped — not evaluated
verify: binding   skipped — not evaluated
FAIL: stage=signature reason=signature_invalid
```

Note: `verify` always needs the grant (`--committed-grant`, or
`--committed-grant-file`+`--entry-id`) — the binding stage checks the leaf
commits the grant.

---

## Preflight (rehearsal — run BEFORE the talk)

Stand up a live ES256 univocity instance and provision one root grant, so the
on-stage "start in the middle" opening has something to register against. This
also captures the artefacts every later step consumes: `deployment.json`,
`genesis.cbor`, `bootstrap.es256.pem`, `root-grant.b64`.

### Canonical environment (export once; every step reads these)

```bash
export FORESTRIE_BASE_URL="https://api-b-forest-2.forestrie.dev"   # SCRAPI worker origin, no trailing slash
export RPC_URL="https://sepolia.base.org"
export CHAIN_ID=84532                                              # Base Sepolia
# Filled in by the deploy step:
export UNIVOCITY_ADDRESS=                                          # 0x… ImutableUnivocity contract
export BOOTSTRAP_LOG_ID=                                           # root/bootstrap log UUID
# Delegation coordinator (for the `delegate` beats) + the lane-A pinned registrar key:
export DELEGATION_COORDINATOR_URL="https://coordinator-a.forest-2.forestrie.dev"
export PINNED_REGISTRAR_KEY="z1YarLKXrsRe5egrwrFfbeYadd9lOqplKxbRuMGymHUOSY7YAfdOhhPWb3H72TrPMiMLw0CBMpDPXUGMEvbkOQ=="
# Signing keys (ES256 P-256 PKCS#8 PEM). BOOTSTRAP_PEM = Robert's K(root):
export BOOTSTRAP_PEM=./bootstrap.es256.pem
export DAVID_PEM=./david.es256.pem                                # David: K(David-auth) + K(David-data)
export ALICE_PEM=./alice.es256.pem
export BOB_PEM=./bob.es256.pem
```

### R1 — Deploy a univocity instance (ES256)

**Status:** `deploy` — **exists / tested** (FOR-340, `deploy.test.ts` +
`deploy-anvil.test.ts`)

```bash
forestrie deploy \
  --bootstrap-alg es256 \
  --bootstrap-es256-generate --bootstrap-es256-pem-out "$BOOTSTRAP_PEM" \
  --owner-address 0xYOUR_DEPLOYER \
  --rpc-url "$RPC_URL" \
  --out deployment.json
export UNIVOCITY_ADDRESS=$(jq -r .imutableUnivocity deployment.json)
export BOOTSTRAP_LOG_ID=$(jq -r .genesisLogId       deployment.json)
```

Example output (illustrative; format matches the `deploy` reporter — with
`--out`, the summary prints to stderr and the record JSON lands in the file):

```
wrote ES256 bootstrap PEM to ./bootstrap.es256.pem
ImutableUnivocity deployed at: 0xAbC…123
genesisLogId: 0f9a1c7e-…-…
chainId: 84532  txHash: 0x9f…21
wrote deployment record to deployment.json

# deployment.json:
{ "imutableUnivocity": "0xAbC…123", "genesisLogId": "0f9a1c7e-…-…",
  "bootstrapAlg": "es256", "chainId": 84532, "txHash": "0x9f…21" }
```

Note: on a real deploy, add `--deployer-key` (env `DEPLOYER_KEY`) — a
gas-paying secp256k1 key, distinct from the ES256 bootstrap trust root.

### R2 — Fetch the public genesis (cache it; verification is offline forever after)

**Status:** plain HTTP (SCRAPI discovery) — **exists / tested**

```bash
curl -sS "$FORESTRIE_BASE_URL/api/forest/$BOOTSTRAP_LOG_ID/genesis" -o genesis.cbor
curl -sS "$FORESTRIE_BASE_URL/.well-known/scitt-configuration" | jq .
```

Example output:

```
{
  "issuer": "https://api-b-forest-2.forestrie.dev",
  "registration_endpoint": "https://api-b-forest-2.forestrie.dev/register",
  "supported_signature_algorithms": ["ES256"]
}
```

### R3 — Mint + register the root grant (bootstrap leaf is self-referential)

**Robert** stands up the root. The first leaf in the root log is allowed to be
self-referential (`logId == ownerLogId`) because the signer is the bootstrap
public key bound to the contract at deploy time — creating a log and becoming
its `K(L)` is the `create-log` authority. This yields `ROOT_GRANT_B64`, the
opaque bearer credential the on-stage opening treats as "explained later".

**Status:** `create-log` — **tbd** (FOR-390, plan-2607-21; absorbs the
self-referential create path from `register-grant`)

```bash
forestrie create-log \
  --base-url "$FORESTRIE_BASE_URL" \
  --owner-log "$BOOTSTRAP_LOG_ID" --new-log "$BOOTSTRAP_LOG_ID" \
  --sign-with "$BOOTSTRAP_PEM" \
  --self-referential \
  --out-b64 root-grant.b64
export ROOT_GRANT_B64=$(cat root-grant.b64)
```

Example output (illustrative; format matches the `create-log` reporter):

```
ownerLog: 0f9a1c7e-…-… (grant leaf)
dataLog: 0f9a1c7e-…-… (authorized)
signer: 04a91f…            # grantData = bootstrap ES256 x||y
entryId: 0202020202020202…0001
statusUrl: https://api-b-forest-2.forestrie.dev/register/0f9a1c7e-…/grants/…
receiptUrl: …/receipt
wrote completed grant base64 to root-grant.b64
```

---

## Opening line (say once, then prove it)

> "Forestrie is a **pipe, not a store**." — don't argue it; Steps 4–5 are the proof.

---

## Step 1 — Register a signed statement  ·  ~4 min

**Status:** `sign-statement` — **exists / tested** (FOR-341) · `register` —
**exists / tested** (FOR-342)

**Slide:**
- Get a verifiable receipt into your hands *before* any chain talk
- Just a plain COSE Sign1 statement — any SCRAPI client works
- The `Authorization: Forestrie-Grant …` header: an opaque bearer, "explained later"
- Close: run the offline verifier → `ok`

**Speaker notes:** Start in the middle. We register a signed statement and get
back a receipt anyone can verify offline — that's the payoff first, mechanics
later. The grant header is just a bearer credential right now; where it comes
from is Step 3. `kid` is the first 32 bytes of `x||y` under ES256. Emphasise:
this is plain COSE, nothing forestrie-specific about the client.

**1a. Sign a statement:**

```bash
echo '{"claim":"hello scitt wg","ts":"2026-07-11"}' > statement.json
forestrie sign-statement \
  --key "$ALICE_PEM" \
  --payload statement.json --content-type application/json \
  --out statement.cose
```

Example output (real run against `main`, ES256 key generated with `openssl`):

```
signed statement: plain COSE Sign1 (ES256)
  kid:       241115ab754013fcbf2e88544a369009d5d7de7f54497ad640ef28ad6237392c
  payload:   45 bytes (application/json)
  statement: 173 bytes -> statement.cose
```

**1b. Register it** (posts the COSE Sign1 with the grant header, follows the
303, polls, downloads the receipt):

```bash
forestrie register \
  --base-url "$FORESTRIE_BASE_URL" \
  --log-id "$BOOTSTRAP_LOG_ID" \
  --statement statement.cose \
  --grant-b64 "$ROOT_GRANT_B64" \
  --out receipt.cbor
export GRANT_B64="$ROOT_GRANT_B64"
```

Example output (illustrative; format matches the `register` reporter):

```
entryId: 0202020202020202…0001
statusUrl: https://api-b-forest-2.forestrie.dev/register/0f9a1c7e-…/entries/…
receiptUrl: …/receipt
wrote receipt (612 bytes) to receipt.cbor
```

**Close:** run **the single closer** (`forestrie verify … → ok`).

---

## Step 2 — Authorize several signers on a data log  ·  ~5 min

**Status:** `create-log` — **tbd** (FOR-390, plan-2607-21) · `register-grant`
(writer-only) — **exists / tested** (FOR-343) · reuses `sign-statement` /
`register` / `verify` (all **exists / tested**)

**Slide:**
- **SCITT built using SCITT** — the TS implements its *own* authorization out of COSE-signed statements and receipts
- Authorization is a **hierarchy of forestrie logs**: Robert's root → David's auth log → David's data log; each grant is just `register-signed-statement` on the parent
- **Create vs. write are different authorities:** `create-log` makes David the owner (`K(L)`) of a log; `register-grant` only lets Alice and Bob *append* statements — no create, no re-root
- One writer grant per signer, all naming the **same data log**, all recorded in the **auth log** — not a side channel
- Delegation is itself a transparent, receipted statement you verify like any other

**Speaker notes:** SCITT requires the Transparency Service to authorize what it
registers; forestrie meets that requirement *with SCITT itself* — a grant is a
signed statement, recorded and receipted in an auth log, and verified exactly
like the data entries. That is the whole point to land: **"SCITT built using
SCITT."** Skip the grant-payload internals (signer binding, uniqueness gating,
the creation-grant 409) — they are forestrie specifics this audience isn't here
for and risk derailing the slide.

**2a. Robert creates David's auth log** (`create-log`, signed by the root key;
`grantData` = David, so **David becomes the owner** — `K(David-auth)`):

```bash
export AUTH_LOG_ID=$(uuidgen | tr 'A-Z' 'a-z')
export DATA_LOG_ID=$(uuidgen | tr 'A-Z' 'a-z')

forestrie create-log \
  --base-url "$FORESTRIE_BASE_URL" \
  --owner-log "$BOOTSTRAP_LOG_ID" --new-log "$AUTH_LOG_ID" \
  --auth-log \
  --signer-pem "$DAVID_PEM" \
  --sign-with "$BOOTSTRAP_PEM" \
  --parent-grant-b64 "$ROOT_GRANT_B64" \
  --out-b64 auth-grant.b64
```

**2b. David creates his data log** under his auth log (`create-log`, signed by
David — the auth log's owner; `grantData` = David, so `K(David-data)` is David):

```bash
forestrie create-log \
  --base-url "$FORESTRIE_BASE_URL" \
  --owner-log "$AUTH_LOG_ID" --new-log "$DATA_LOG_ID" \
  --data-log \
  --signer-pem "$DAVID_PEM" \
  --sign-with "$DAVID_PEM" \
  --parent-grant-b64 "$(cat auth-grant.b64)" \
  --out-b64 david-data-grant.b64
```

**2c. David authorizes Alice and Bob as writers** on his data log (one
**extend-only** writer grant per signer — no `GF_CREATE` — both naming
`$DATA_LOG_ID`, both recorded in `$AUTH_LOG_ID`, all signed by **David**, the
data log's owner):

```bash
for who in ALICE BOB; do
  pem_var="${who}_PEM"
  forestrie register-grant \
    --base-url "$FORESTRIE_BASE_URL" \
    --owner-log "$AUTH_LOG_ID" --data-log "$DATA_LOG_ID" \
    --signer-pem "${!pem_var}" \
    --parent-grant-b64 "$(cat david-data-grant.b64)" \
    --sign-with "$DAVID_PEM" \
    --out-b64 "grant-${who,,}.b64"
done
```

Example output (illustrative; a `create-log`/`register-grant` summary per call):

```
# 2a — David's auth log (create-log, owner = David):
ownerLog: 0f9a1c7e-… (grant leaf)
newLog: 8c2e4b…-… (created)
owner: 04d4v1d…          # grantData = David ES256 x||y
entryId: …
wrote completed grant base64 to auth-grant.b64

# 2b — David's data log (create-log, owner = David):
ownerLog: 8c2e4b…-… (grant leaf)
newLog: d41d8c…-… (created)
owner: 04d4v1d…          # grantData = David
wrote completed grant base64 to david-data-grant.b64

# 2c — Alice, then Bob (register-grant, writer, extend-only):
ownerLog: 8c2e4b…-… (grant leaf)
dataLog: d41d8c…-… (authorized)
signer: 9b3a…            # Alice ES256 x||y   (flags: GF_EXTEND|GF_DATA_LOG, no GF_CREATE)
entryId: …
wrote completed grant base64 to grant-alice.b64
```

**2d. Pre-delegate sealing to the operator's vouched key** (`delegate`). Each
log's owner verifies the custodian's standing sealer key against the pinned
registrar key, then signs a wide-horizon delegation authorizing that sealer to
publish checkpoints on their behalf — three logs, three delegations, the minimal
and hierarchical set. Public coordinator endpoints only; no operator token.

```bash
# Robert delegates the root log:
forestrie delegate \
  --coordinator-url "$DELEGATION_COORDINATOR_URL" \
  --log-id "$BOOTSTRAP_LOG_ID" --sign-with "$BOOTSTRAP_PEM" \
  --pinned-registrar-key "$PINNED_REGISTRAR_KEY"

# David delegates his auth log and his data log:
for log in "$AUTH_LOG_ID" "$DATA_LOG_ID"; do
  forestrie delegate \
    --coordinator-url "$DELEGATION_COORDINATOR_URL" \
    --log-id "$log" --sign-with "$DAVID_PEM" \
    --pinned-registrar-key "$PINNED_REGISTRAR_KEY"
done
```

Example output (illustrative; format matches the `delegate` reporter):

```
delegate: standing  — sealerId sealer-a epoch 1 (from pending-delegation)
delegate: voucher   ok      — verifies against pinned registrar key
delegate: horizon   — mmr 0..9007199254740991 (wide; permanent within range)
delegate: submit    ok      — POST /api/delegations/certificate → 202
```

**2e. Each signer registers a statement to the data log:** reuse
`sign-statement` + `register` from Step 1 with `--log-id "$DATA_LOG_ID"` and
`--grant-b64 "$(cat grant-alice.b64)"` / `grant-bob.b64`.

**Close:** run **the single closer** for each new receipt.

---

## Step 3 — Where did that grant come from? Univocity bootstrap  ·  ~4 min

**Status:** on-stage proof uses `cast call` (foundry) — **exists / tested**.
The deploy it explains is `forestrie deploy` — **exists / tested** (FOR-340),
but shown from a **recorded clip** (FOR-355) of the browser `deploy-web` flow,
not run live.

**Slide:**
- This step delivers **Non-equivocation** — a required VDS property in [RFC 9943 §5.1.3](https://www.rfc-editor.org/rfc/rfc9943.html#name-verifiable-data-structure) (with Append-only and Replayability)
- The opaque bearer from Step 1 = a **self-referential bootstrap grant**, valid because its signer is the bootstrap key **bound to the univocity contract at deploy**
- Split-view protection is **externalised from the operator to the contract** — a contract invariant, not operator behaviour: univocity advances the accumulator only on a valid **consistency proof**, and Ethereum consensus makes that one global view
- A receipt is split-view protected once its peak **has reached (or ever reached) the chain**
- Prove the binding live: on-chain `bootstrapConfig` == the key that signed the grant

**Speaker notes:** This is where forestrie answers **non-equivocation**. The
mechanism, stated plainly: the contract only advances a log's accumulator when
handed a valid **consistency proof**, and Ethereum consensus guarantees a single
global view — so a receipt whose peak has reached the chain cannot be shown
differently to two relying parties. Pay off "explained later": play the recorded
Playwright clip of the browser deploy via `deploy-web` — burner wallet, "Privy
is the example web3 wallet." Do NOT deploy live; the instance was provisioned in
Preflight. Then one `cast call`: the contract's bootstrap config is exactly the
ES256 key that signed `root-grant.b64`. Keep the log-hierarchy details and the
"bootstrap can stop granting publish rights" mechanics **in your pocket** —
mention only if asked; for this audience they distract from the one clean point:
non-equivocation via consensus.

```bash
cast call "$UNIVOCITY_ADDRESS" "bootstrapConfig()(int64,bytes)" --rpc-url "$RPC_URL"
```

Example output:

```
-7
0x04a91f…   # x||y of the bootstrap key that signed root-grant.b64  (alg -7 == ES256) ```
**Close:** re-run **the single closer** on the Step 1 receipt — same command,
now the audience understands the grant it verifies. Plant the thread for the
finale: split-view protection lives in the contract, **not the operator** —
which is exactly why the operator turns out to be a swappable pipe (Step 5).

---

## Step 4 — Self-serve receipts (the pipe, not the store)  ·  ~5 min

**Status:** `create-receipt` offline mode — **exists / tested** (FOR-345,
`create-receipt.test.ts`) · `decode-receipt` — **exists / tested** (FOR-346) ·
`complete-grant` — **exists / tested** (FOR-344, `complete-grant.test.ts`)

**Slide:**
- Receipts sign **individual accumulator members (peaks), not a single tree head** — the reason all of this works
- So receipts are **derivable from the data** — the API endpoint is a convenience, not an authority
- Hold the **tile** of data with your leaf and you can (re)derive a valid receipt — no operator refresh
- Self-created receipt is **byte-identical** to an API-issued one; decode it live — just COSE (Sign1 + MMR inclusion)

**Speaker notes:** This is where "pipe not a store" becomes concrete, and it
rests entirely on the profile's peak-signing. This step builds on Step 3 but
makes a *different* point: Step 3 established that the accumulator is
*authoritative* (consensus-gated); here we show each signed *peak* is a
self-contained attestation, so a client with the massif `.log` tile rebuilds
the leaf→peak path and attaches it to the pre-signed peak receipt — producing
the exact bytes the operator would have. Inclusion paths are unsigned and
recomputable (same property as the arbor publisher rebuild fix). Decode it on
screen so they see there's no magic — Sign1 plus an MMR inclusion proof.

**4a. Self-create the receipt — no operator call:**

```bash
curl -sS "$FORESTRIE_BASE_URL/api/forest/$DATA_LOG_ID/massifs/0.log" -o massif.log
curl -sS "$FORESTRIE_BASE_URL/api/forest/$DATA_LOG_ID/checkpoint.sth" -o checkpoint.sth

forestrie create-receipt \
  --massif massif.log --checkpoint checkpoint.sth \
  --mmr-index 0 \
  --out receipt.selfserve.cbor
```

Example output (**real capture** — run against emitted fixture massif +
checkpoint, leaf at `--mmr-index 0`):

```
create-receipt: massif     — index 0 (height 3, mmr indexes 0..3)
create-receipt: leaf       — mmrIndex 0 (from --mmr-index)
create-receipt: checkpoint — sealed size 4, 2 peak(s)
create-receipt: proof      — 1 node(s) to peak 1/2 (mmrIndex 2)
create-receipt: cert       — delegation cert copied: no
create-receipt: receipt    — 144 bytes -> receipt.selfserve.cbor
```

**4b. Self-create the grant header from a checkpoint** (grants are derivable
from log data, not operator-issued): `complete-grant` locates Alice's grant leaf
in the massif by its commitment hash — recovering the mmrIndex and the sequenced
idtimestamp — rebuilds the inclusion receipt against the checkpoint's pre-signed
peak, and attaches receipt + idtimestamp to produce the completed bearer, with
no operator round-trip.

```bash
forestrie complete-grant \
  --grant grant-alice.b64 \
  --checkpoint checkpoint.sth --massif massif.log \
  --out-b64 grant-alice.completed.b64
```

Example output (**real capture** — offline against a fixture grant + massif +
checkpoint; with `--out-b64` the summary is the stdout product):

```
complete-grant: leaf       — mmrIndex 0 (recovered from massif)
complete-grant: entry id   — 01010101010101010000000000000000 (idtimestamp from massif)
complete-grant: proof      — 1 node(s) to peak 1/2
complete-grant: checkpoint — sealed size 4, delegation cert copied: no
complete-grant: receipt    — 118 bytes attached (header 396)
complete-grant: wrote completed grant (base64) to grant-alice.completed.b64
```

The completed grant is the same `Authorization: Forestrie-Grant` bearer
`register-grant` produces online — verify-equivalent, no operator call.

**4c. Decode it live** — show it's just COSE:

```bash
forestrie decode-receipt receipt.selfserve.cbor
```

Example output (**real capture** — human tree; add `--json` for the
machine-readable form):

```
COSE_Sign1 — tagged 18 (COSE_Sign1) — 304 bytes
├─ protected: 21 bytes (CBOR map, covered by the signature)
│  ├─ 1 (alg): -7 — ES256 (ECDSA P-256 + SHA-256)
│  ├─ 4 (kid): 6c6c6c6c6c6c6c6c6c6c6c6c (12 bytes)
│  └─ 395 (verifiable data structure): 3 — MMR profile (draft-bryce, codepoint TBD)
├─ unprotected: (not covered by the signature)
│  ├─ 396 (verifiable proofs):
│  │  └─ -1 (inclusion proofs): 1 entry
│  │     ├─ 1 (mmr index): 5
│  │     └─ 2 (path): 3 × 32-byte hashes
│  ├─ 1000 (delegation certificate): 81 bytes — parses as a nested COSE_Sign1
│  └─ -70000 (unknown label): "mystery"
├─ payload: detached (nil) — the verifier recomputes the MMR peak from the inclusion path
└─ signature: 64 bytes — 9999999999999999…9999

MMR inclusion
  mmr index:    5
  path length:  3
  peak:         derived at verify time (detached payload)
```

Caveat for rehearsal: `decode-receipt` (and `verify`) need **canonically
encoded** COSE receipts. Operator/API-issued receipts are canonical; the
self-serve receipt from **4a** decodes fine when its checkpoint carries
canonical peak receipts (a real operator massif does).

**Close:** run **the single closer** on `receipt.selfserve.cbor` — a receipt
the operator never issued verifies identically. *That* is the pipe.

**The bridge to Step 5 (say it here):** there are two verification modes.
Offline against the cached checkpoint (this step's closer) checks the COSE
signature against the trusted ES256 sealer key *and* recomputes the peak from
the path — you can cache that checkpoint forever, no revocation, because the
sealer key was gatekept by the contract at publish. Chain-anchored (Step 5)
drops the signature check entirely and just recomputes the peak against the
on-chain accumulator — **this is the externalised split-view check itself**:
trust reduces to univocity and Ethereum, never the operator.

---

## Step 5 — Operator exit: self-serve receipts + last massif = walk away  ·  ~4 min


**Status:** chain-anchored **`verify`** (`--univocity/--log-id/--rpc-url`) —
**exists / tested** (FOR-347, `verify-anchored.ts`). The chain-anchored
**`create-receipt --univocity`** mode is now also **exists / tested**
(report-only, FOR-345 #13, tested against a mocked `logState`). Either proves
the on-stage point; the demo uses `verify` so the closer command stays the
same. Confirmed live: `create-receipt --univocity` with no reachable RPC exits
`create_receipt_chain_failed` / "Unable to connect" — a real chain attempt, not
a stub.

**Slide:**
- **The crux of "pipe, not store":** SCITT + COSE Receipts + the MMR profile separate **sequencing** (the operator) from **auditing/monitoring** and **split-view protection** (externalised to univocity, on-chain)
- The **operator is just a pipe** — it doesn't provide non-equivocation, so it's fungible: **many logs, and many univocity instances, can share one operator**, and switching operators is trivial
- Stop trusting the operator? You need **nothing** from it — last massif blob + on-chain checkpoint = keep issuing and verifying forever
- Chain-anchored verify: recompute the peak, match the on-chain accumulator — **no signature needed**
- Residual trust is small and explicit — **your own log key** + **univocity** (bootstrapper not censoring your publish rights) + Ethereum; **never the operator**

**Speaker notes:** The finale, and the crux of the whole "pipe" argument. The
key move is that **split-view protection is externalised from the operator to
univocity** — so the operator never carries non-equivocation. That's what makes
it a genuine pipe: it only sequences, and it's fungible — **many logs and many
univocity instances can point at the same operator**, so switching operators is
trivial and you need nothing from any one of them to keep verifying. Then be
honest about what trust *does* remain, so the claim doesn't ring hollow: you own
the log key, you trust **univocity** (Ethereum consensus for non-equivocation,
and the bootstrapper not to censor your publish rights) — a contract-bound
assumption, not an operator one. Verification collapses to recomputing a peak
and checking it's in the on-chain accumulator (the checkpoint signer was already
verified by the contract on publish, so you drop the signature entirely). Answer
Q3 on the way past: control of your signing key is the delegation bound — the
`delegate` beats in Step 2d are where each owner (Robert for the root, David for
his two logs) verified the custodian's vouched sealer key and pre-authorized it
to publish; the operator still only sequences. A self-hosted owner who signs
their own checkpoints needs no delegation at all.

**5a. Verify the receipt's peak against the on-chain accumulator** (no
operator, only the contract — `verify` reads `logState(bytes32)` over JSON-RPC
and asserts the receipt's peak is one of the anchored accumulator peaks):

```bash
forestrie verify \
  --genesis genesis.cbor --receipt receipt.cbor --committed-grant "$GRANT_B64" \
  --univocity "$UNIVOCITY_ADDRESS" --log-id "$DATA_LOG_ID" --rpc-url "$RPC_URL"
```

Example output (illustrative; format matches the `verify` reporter's
chain-anchored branch — needs a live RPC to capture):

```
verify: parse     ok      — receipt COSE decodes; genesis trust root loads (ES256)
verify: signature ok      — checkpoint signature verifies under the genesis trust key
verify: inclusion ok      — proof path recomputes the checkpoint peak
verify: binding   ok      — leaf binds the grant commitment at the receipt idtimestamp
verify: anchor    ok      — receipt peak matches on-chain accumulator peak 1/2 at anchored size 4
PASS: receipt verified offline and anchored on-chain (anchored size 4)
```

**5b. The whole audience verifies, offline, forever** — run **the single
closer** one last time. Land the closing line:

> "The operator was only ever a pipe — split-view protection and the trust that
> matters live on-chain. Cache the checkpoint forever, self-serve your receipts,
> swap operators at will, and walk away. **It's a pipe, not a store.**"

---

## Aside — Multisig Safe root (pre-provisioned, ≤60s)  ·  optional

**Status:** read-only `cast call` against a KS256 deployment — **exists /
tested** (plan-0031 Root Safe on Base Sepolia). Off the ES256 arc; a separate,
pre-provisioned deployment.

**Slide:**
- The bootstrap identity can be your org's **signing policy**, not a person's laptop
- KS256 `rootKey` is an address; the contract verifies via **ERC-1271**
- Show `logConfig(logId).rootKey` == the Safe address on-chain
- `fupduck.eth` (the 1-of-n) signs one action — no live Safe administration

**Speaker notes:** 60 seconds, read-only. Do not switch algorithms inside the
core hierarchy — this is a separate KS256 deployment. Show the on-chain root
key equals the Safe address, have the single signer approve one action, and
land the line about signing policy. Anything more steals time from the receipt
story.

```bash
cast call "$KS256_UNIVOCITY_ADDRESS" "logConfig(bytes32)(...)" <log-id> --rpc-url "$RPC_URL"
```

Example output:

```
rootKey: 0xSafe…addr   # == Root Safe (ERC-1271); fupduck.eth is the 1-of-n
```

**Line to land:** "the bootstrap identity can be your org's signing policy, not
a person's laptop."
