# Zero to Hero — demo outline

Presentation outline for the IETF SCITT WG MMR-profile adoption call. Each
section is one slide: the on-screen bullets, the speaker notes, the
`forestrie` command it runs, and example output.

**Audience: the IETF SCITT WG. This demo lands exactly three things — everything
else is subordinate:**

1. **Split-view protection** (non-equivocation) — no two relying parties can be
   shown a different log.
2. **Offline, self-served receipts** — anyone holding the data can obtain and
   verify a receipt with no operator in the loop.
3. **The
   [MMR profile](https://github.com/robinbryce/draft-bryce-cose-receipts-mmr-profile/blob/main/draft-bryce-cose-receipts-mmr-profile.md)
   is what enables BOTH** — because a receipt signs accumulator **peaks
   (members)**, not a single tree head. A signed peak covers many leaves and
   stays valid as the log grows, so (a) any client with the data can *re-derive*
   a valid receipt offline, and (b) verifying a peak against the public record
   *substitutes for* checking the signer — which is exactly what makes it
   non-equivocable. This is the paper's thesis; keep it the through-line. Every
   step below is one instance of it.

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
mode. The two authority verbs — **`create-log`** (with `--self-referential`,
`--auth-log`, `--data-log`, and `--prepare`) and **`delegate`** — are now
**exists / validated live** (FOR-390): the full ordering below ran green
end-to-end against lane-A, with the first checkpoint landing at every hierarchy
level in a few seconds. See
[plan-2607-21](https://github.com/forestrie/devdocs/blob/main/plans/plan-2607-21-cli-authority-commands-demo.md)
(verbs), the child-onboarding decision
[ADR-0053](https://github.com/forestrie/devdocs/blob/main/adr/adr-0053-child-log-onboarding-parent-authorized.md)
+ [plan-2607-23](https://github.com/forestrie/devdocs/blob/main/plans/plan-2607-23-child-log-advance-delegation-onboarding.md),
and the authority taxonomy
[ADR-0052](https://github.com/forestrie/devdocs/blob/main/adr/adr-0052-cli-authority-taxonomy.md).

**One non-CLI step**: onboarding a forest's **root genesis** is an
**operator/self-host** action, not a `forestrie` verb — `POST /api/forest/{root}/genesis`
with an operator/self-host onboard bearer (or a completed endorsement grant).
The operator onboards you; you onboard yourself when self-hosting. Every
*child* log, by contrast, onboards under **parent-log authority with no operator
token** (ADR-0053) — authority flows down the log hierarchy, not through the
operator.

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

It is this same peak-signing property that lets **verifying a peak against the
public record stand in for receipt-signature verification** (Step 5): once the
peak is on the public record, checking it *there* substitutes for checking the
signer — which is what makes it non-equivocable. Contrast: a tree head signs a
*single* state of the log, so it speaks only to that snapshot; an accumulator's
signed peaks cover many leaves and keep proving inclusion as the log grows — the
same signature stays useful forever.

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

Stand up a live ES256 univocity instance, **onboard its root genesis** (which
also forwards the root's public root + webhook to the delegation coordinator),
**pre-delegate the root before the first write**, then provision one root grant
— so the on-stage "start in the middle" opening has something to register
against and its first checkpoint lands in seconds. This also captures the
artefacts every later step consumes: `deployment.json`, `genesis.cbor`,
`bootstrap.es256.pem`, `root-grant.b64`.

**Validated ordering (this ran green live against lane-A):** deploy → onboard
the root genesis *with the coordinator forward* → `delegate` the root →
`create-log --self-referential` the root grant. Delegating **before** the first
write is the whole point: the advance certificate is already in place, so the
sealer's first checkpoint finds a covering cert immediately.

### Canonical environment (export once; every step reads these)

```bash
# lane-A is the live deployment — there is no lane-B host (api-b-forest-2 /
# api-a-forest-2 are down/stale; lane-B is not deployed). Use the plain host:
export FORESTRIE_BASE_URL="https://api-forest-2.forestrie.dev"   # SCRAPI worker origin, no trailing slash
export RPC_URL="https://sepolia.base.org"
export CHAIN_ID=84532                                              # Base Sepolia
# Filled in by the deploy step (BOOTSTRAP_LOG_ID *is* the forest root log id):
export UNIVOCITY_ADDRESS=                                          # 0x… ImutableUnivocity contract
export BOOTSTRAP_LOG_ID=                                           # root/bootstrap log UUID (== forest root)
# Delegation coordinator (for the `delegate` beats) + the lane-A pinned registrar key:
export DELEGATION_COORDINATOR_URL="https://coordinator-a.forest-2.forestrie.dev"
export PINNED_REGISTRAR_KEY="z1YarLKXrsRe5egrwrFfbeYadd9lOqplKxbRuMGymHUOSY7YAfdOhhPWb3H72TrPMiMLw0CBMpDPXUGMEvbkOQ=="
# Operator/self-host onboard token for the *root* genesis onboard (Preflight R2).
# Minted via the ops API; child logs need NO token (parent-authorized, ADR-0053):
export CANOPY_PAYMENTS_ONBOARD_TOKEN=                             # operator/self-host onboard bearer
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

### R2 — Onboard the root genesis (operator/self-host; forwards to the coordinator)

Onboarding a forest's root genesis is an **operator/self-host** step, **not** a
`forestrie` verb: the operator onboards you, or you onboard yourself when
self-hosting. It stores the canonical genesis (so the GET in R3 works) **and**,
because we pass `?webhookUrl=`, forwards the root's public root + webhook to the
delegation coordinator — the prerequisite for delegating the root in R4.
Authorize it with the operator/self-host onboard bearer
(`CANOPY_PAYMENTS_ONBOARD_TOKEN`, minted via the ops API) **or** a completed
endorsement grant.

**Status:** operator/self-host onboard (`POST /api/forest/{root}/genesis`) —
**operator step, validated live** (FOR-390). Not a CLI verb.

```bash
# CBOR genesis body labels: version(-68009)=2, alg(-68014)=-7 (ES256),
#   bootstrapKey(-68015)=64-byte x‖y, univocityAddr(-68011)=20 bytes,
#   chainId(-68013)="84532". (Same bytes the deploy step bound on-chain.)
# WEBHOOK_URL is the operator's signing-route URL the coordinator calls back —
# the same signing route the genesis forward uses (an operator/self-host detail):
curl -sS -X POST \
  -H "Authorization: Bearer $CANOPY_PAYMENTS_ONBOARD_TOKEN" \
  -H "Content-Type: application/cbor" \
  --data-binary @genesis-body.cbor \
  "$FORESTRIE_BASE_URL/api/forest/$BOOTSTRAP_LOG_ID/genesis?webhookUrl=$WEBHOOK_URL"
```

The `webhookUrl` is mandatory for the coordinator forward: without it, R4's
`delegate` finds no registered public root and 404s at certificate submission.

### R3 — Fetch the public genesis (cache it; verification is offline forever after)

**Status:** plain HTTP (SCRAPI discovery) — **exists / tested**

```bash
curl -sS "$FORESTRIE_BASE_URL/api/forest/$BOOTSTRAP_LOG_ID/genesis" -o genesis.cbor
curl -sS "$FORESTRIE_BASE_URL/.well-known/scitt-configuration" | jq .
```

Example output:

```
{
  "issuer": "https://api-forest-2.forestrie.dev",
  "registration_endpoint": "https://api-forest-2.forestrie.dev/register",
  "supported_signature_algorithms": ["ES256"]
}
```

### R4 — Delegate the root log (BEFORE the first write)

**Robert** pre-delegates sealing on the root log to the operator's vouched
standing sealer key: `delegate` fetches the pending delegation, verifies the
custodian's sealer voucher against the **pinned registrar key**, signs a
wide-horizon delegation with `K(root)`, and submits it. Doing this *before* R5's
first write is what makes the first checkpoint land in seconds. Advance-cert TTL
is now 6h (`STANDING_DELEGATION_TTL_SECONDS`, canopy#133), so one `delegate` is
durable for the whole rehearsal + talk.

**Status:** `delegate` — **exists / validated live** (FOR-390, plan-2607-21)

```bash
forestrie delegate \
  --coordinator-url "$DELEGATION_COORDINATOR_URL" \
  --log-id "$BOOTSTRAP_LOG_ID" --sign-with "$BOOTSTRAP_PEM" \
  --pinned-registrar-key "$PINNED_REGISTRAR_KEY"
```

### R5 — Mint + register the root grant (bootstrap leaf is self-referential)

**Robert** stands up the root. The first leaf in the root log is allowed to be
self-referential (`logId == ownerLogId`) because the signer is the bootstrap
public key bound to the contract at deploy time — creating a log and becoming
its `K(L)` is the `create-log` authority. With the root already delegated (R4),
the sealer covers this leaf immediately, so the receipt returns in ~4–8s. This
yields `ROOT_GRANT_B64`, the opaque bearer credential the on-stage opening
treats as "explained later".

**Status:** `create-log --self-referential` — **exists / validated live**
(FOR-390, plan-2607-21; absorbs the self-referential create path from
`register-grant`)

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
statusUrl: https://api-forest-2.forestrie.dev/register/0f9a1c7e-…/grants/…
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
statusUrl: https://api-forest-2.forestrie.dev/register/0f9a1c7e-…/entries/…
receiptUrl: …/receipt
wrote receipt (612 bytes) to receipt.cbor
```

**Close:** run **the single closer** (`forestrie verify … → ok`).

---

## Step 2 — Authorize several signers on a data log  ·  ~5 min

**Status:** `create-log` (`--prepare` / `--auth-log` / `--data-log`) and
`delegate` — **exists / validated live** (FOR-390, plan-2607-21 + ADR-0053 /
plan-2607-23) · `register-grant` (writer-only) — **exists / tested** (FOR-343) ·
reuses `sign-statement` / `register` / `verify` (all **exists / tested**)

**Slide:**
- **SCITT built using SCITT** — SCITT requires the Transparency Service to authenticate and authorize what it registers. We implemented that authorization for *this* TS out of SCITT itself.
- Each authorization is a **COSE-signed statement** — registered, receipted, and verified with the **very same offline verifier** as any data entry.
- So the TS's access control is **transparent log content you audit exactly like the data** — not a private side channel.
- Close: Alice and Bob each register to the data log, then run the single closer on every new receipt — **authorization and data verify identically**.

**Speaker notes:** One idea to land here: **"SCITT built using SCITT."** SCITT
requires the Transparency Service to authorize what it registers; we met that
requirement *with SCITT itself* — every authorization is a COSE-signed
statement, registered and receipted in a log, and verified with the exact same
offline verifier (the single closer) as any data entry. The access-control
plane is not bespoke and not hidden — it is transparent, auditable log content.
That is the whole slide. The commands below actually build the authorization
graph and are needed to run it live, but on stage you narrate the one idea and
let the closer prove it: the grant that authorized Alice verifies with the same
command as Alice's statement.

**Mechanics — keep in your pocket, mention only if asked.** The rest of this
step is the authorization *mechanism*; it's distracting for this audience, so
don't lead with it. If a chain of hierarchy questions comes up:
- Authorization is a **hierarchy of logs**: Robert's root → David's auth log → David's data log; each grant is a signed statement registered on the parent.
- **Create vs. write are different authorities:** `create-log` makes David the owner (`K(L)`) of a log; `register-grant` only lets Alice and Bob *append* — no create, no re-root.
- **Owners pre-sign their own logs with their own key.** Per child log the reliable ordering is **prepare → delegate → create**: `prepare` registers the child's public root at the coordinator under the *parent*-signed create grant (verified recursively down to the root genesis), so the owner can `delegate` and pre-sign a log **before it is sequenced**, with **no operator token** — authority flows down the log hierarchy, not through the operator (ADR-0053). The root was already delegated in Preflight (R4); David does the same for each of his logs, picking both logIds up front. Pre-delegated, each level's first checkpoint lands in ~4–8s.
- Skip the grant-payload internals (signer binding, uniqueness gating, the creation-grant 409) entirely — forestrie specifics, not why this audience is here.

```bash
export AUTH_LOG_ID=$(uuidgen | tr 'A-Z' 'a-z')
export DATA_LOG_ID=$(uuidgen | tr 'A-Z' 'a-z')
```

**2a. David's auth log — prepare → delegate → create** (create grant signed by
**Robert**, `grantData` = David, so **David becomes the owner** `K(David-auth)`;
owner-log = the root, so `--bootstrap-log` defaults correctly to it):

```bash
# prepare: Robert signs the create grant; registers the child public root at
# the coordinator under root authority (no sequencing, no operator token):
forestrie create-log --prepare \
  --base-url "$FORESTRIE_BASE_URL" \
  --owner-log "$BOOTSTRAP_LOG_ID" --new-log "$AUTH_LOG_ID" \
  --auth-log \
  --signer-pem "$DAVID_PEM" \
  --sign-with "$BOOTSTRAP_PEM" \
  --parent-grant-b64 "$ROOT_GRANT_B64" \
  --out-b64 auth-grant.b64

# delegate: David (the new owner) pre-delegates sealing on his auth log:
forestrie delegate \
  --coordinator-url "$DELEGATION_COORDINATOR_URL" \
  --log-id "$AUTH_LOG_ID" --sign-with "$DAVID_PEM" \
  --pinned-registrar-key "$PINNED_REGISTRAR_KEY"

# create: sequence the create leaf (same args, minus --prepare) — fast receipt:
forestrie create-log \
  --base-url "$FORESTRIE_BASE_URL" \
  --owner-log "$BOOTSTRAP_LOG_ID" --new-log "$AUTH_LOG_ID" \
  --auth-log \
  --signer-pem "$DAVID_PEM" \
  --sign-with "$BOOTSTRAP_PEM" \
  --parent-grant-b64 "$ROOT_GRANT_B64" \
  --out-b64 auth-grant.b64
```

**2b. David's data log — prepare → delegate → create** (create grant signed by
**David** — the auth log's owner; `grantData` = David, so `K(David-data)` is
David). The owner-log is now David's auth log, **not** the root, so
`--bootstrap-log "$BOOTSTRAP_LOG_ID"` is **required** — `--bootstrap-log`
defaults to `--owner-log`, which is only correct when the owner *is* the forest
root:

```bash
# prepare (David signs; owner = auth log ⇒ must name the forest root explicitly):
forestrie create-log --prepare \
  --base-url "$FORESTRIE_BASE_URL" \
  --owner-log "$AUTH_LOG_ID" --new-log "$DATA_LOG_ID" \
  --bootstrap-log "$BOOTSTRAP_LOG_ID" \
  --data-log \
  --signer-pem "$DAVID_PEM" \
  --sign-with "$DAVID_PEM" \
  --parent-grant-b64 "$(cat auth-grant.b64)" \
  --out-b64 david-data-grant.b64

# delegate David's data log:
forestrie delegate \
  --coordinator-url "$DELEGATION_COORDINATOR_URL" \
  --log-id "$DATA_LOG_ID" --sign-with "$DAVID_PEM" \
  --pinned-registrar-key "$PINNED_REGISTRAR_KEY"

# create (sequence):
forestrie create-log \
  --base-url "$FORESTRIE_BASE_URL" \
  --owner-log "$AUTH_LOG_ID" --new-log "$DATA_LOG_ID" \
  --bootstrap-log "$BOOTSTRAP_LOG_ID" \
  --data-log \
  --signer-pem "$DAVID_PEM" \
  --sign-with "$DAVID_PEM" \
  --parent-grant-b64 "$(cat auth-grant.b64)" \
  --out-b64 david-data-grant.b64
```

**2c. David authorizes Alice and Bob as writers** on his data log (one
**extend-only** writer grant per signer — no `GF_CREATE` — both naming
`$DATA_LOG_ID`, both recorded in `$AUTH_LOG_ID`, all signed by **David**, the
data log's owner). The owner-log is the auth log, so again pass
`--bootstrap-log "$BOOTSTRAP_LOG_ID"` (the forest root):

```bash
for who in ALICE BOB; do
  pem_var="${who}_PEM"
  forestrie register-grant \
    --base-url "$FORESTRIE_BASE_URL" \
    --owner-log "$AUTH_LOG_ID" --data-log "$DATA_LOG_ID" \
    --bootstrap-log "$BOOTSTRAP_LOG_ID" \
    --signer-pem "${!pem_var}" \
    --parent-grant-b64 "$(cat david-data-grant.b64)" \
    --sign-with "$DAVID_PEM" \
    --out-b64 "grant-${who,,}.b64"
done
```

Example output (illustrative; a `create-log`/`delegate`/`register-grant` summary
per call):

```
# 2a prepare — David's auth log public root registered (no sequencing):
prepared child log 8c2e4b…-… (owner 0f9a1c7e-…) — publicRoot ok, webhook ok

# 2a delegate — David pre-delegates the auth log:
delegate: standing  — sealerId sealer-a epoch 1 (from pending-delegation)
delegate: voucher   ok      — verifies against pinned registrar key
delegate: submit    ok      — POST /api/delegations/certificate → 202

# 2a create — auth log sequenced (owner = David), first checkpoint ~4–8s:
ownerLog: 0f9a1c7e-… (grant leaf)
newLog: 8c2e4b…-… (created)
owner: 04d4v1d…          # grantData = David ES256 x||y
wrote completed grant base64 to auth-grant.b64

# 2b — David's data log (prepare → delegate → create, owner = David):
newLog: d41d8c…-… (created)
owner: 04d4v1d…          # grantData = David
wrote completed grant base64 to david-data-grant.b64

# 2c — Alice, then Bob (register-grant, writer, extend-only):
ownerLog: 8c2e4b…-… (grant leaf)
dataLog: d41d8c…-… (authorized)
signer: 9b3a…            # Alice ES256 x||y   (flags: GF_EXTEND|GF_DATA_LOG, no GF_CREATE)
wrote completed grant base64 to grant-alice.b64
```

**2d. Each signer registers a statement to the data log:** reuse
`sign-statement` + `register` from Step 1 with `--log-id "$DATA_LOG_ID"` and
`--grant-b64 "$(cat grant-alice.b64)"` / `grant-bob.b64`.

**Close:** run **the single closer** for each new receipt.

---

## Step 3 — Non-equivocation: the peak reaches a public bulletin board  ·  ~4 min

**Status:** on-stage proof uses `cast call` (foundry) — **exists / tested**.
The deploy it explains is `forestrie deploy` — **exists / tested** (FOR-340),
but shown from a **recorded clip** (FOR-355) of the browser `deploy-web` flow,
not run live.

**Slide:**
- This step delivers **Non-equivocation** — a required VDS property in [RFC 9943 §5.1.3](https://www.rfc-editor.org/rfc/rfc9943.html#name-verifiable-data-structure) (with Append-only and Replayability)
- **The signed peak is posted to a public bulletin board with a single global view** — split-view protection comes from the peak reaching a public record *externalised away from the operator*, not from any one technology
- Because the profile signs **peaks**, verifying a peak against that public record **substitutes for checking the signer** — and *that substitution* is what makes it non-equivocable
- A receipt is split-view protected once its peak **has reached (or ever reached)** the public record
- *(If asked: the bulletin board here is a blockchain — see the pocket aside.)*

**Speaker notes:** This is where forestrie answers **non-equivocation**, and it
rides the MMR profile. The append-only public record carries the accumulator's
signed *peaks*; because a peak covers many leaves, checking the peak *there*
stands in for checking the signer — so a receipt whose peak has reached the
public record cannot be shown differently to two relying parties. Frame it in
terms of the transparency-log **"public bulletin board"** primitive: the
substance is that the peak lands on a public record with one global view,
externalised **away from the operator** — not any particular chain. Pay off
"explained later": play the recorded Playwright clip of the browser deploy via
`deploy-web` — burner wallet, "Privy is the example web3 wallet." Do NOT deploy
live; the instance was provisioned in Preflight. Keep the log-hierarchy details
and the operator-fungibility mechanics **in your pocket**; for this audience the
one clean point is non-equivocation via a public record with a single view.

**Bulletin board, if a chain-savvy attendee asks (optional aside — not an
on-stage beat).** Concretely the public bulletin board here is a blockchain: a
blockchain serves pretty well as the public bulletin board (cf. the Reyzin line
of work / the transparency-log "public bulletin board" primitive). The
univocity contract advances a log's accumulator only on a valid **consistency
proof**, and consensus makes that one global view; the opaque bearer from Step 1
is a self-referential bootstrap grant, valid because its signer is the bootstrap
key bound to that contract at deploy. You can prove that binding live with one
`cast call` — the contract's bootstrap config is exactly the ES256 key that
signed `root-grant.b64`:

```bash
cast call "$UNIVOCITY_ADDRESS" "bootstrapConfig()(int64,bytes)" --rpc-url "$RPC_URL"
```

Example output:

```
-7
0x04a91f…   # x||y of the bootstrap key that signed root-grant.b64  (alg -7 == ES256) ```
**Close:** re-run **the single closer** on the Step 1 receipt — same command,
now the audience understands the grant it verifies. Plant the thread for the
finale: split-view protection lives on the **public record**, **not the
operator** — which is exactly why the operator turns out to be a swappable pipe
(Step 5).

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
*authoritative* (gated by the public record); here we show each signed *peak* is a
self-contained attestation, so a client with the massif `.log` tile rebuilds
the leaf→peak path and attaches it to the pre-signed peak receipt — producing
the exact bytes the operator would have. Inclusion paths are unsigned and
recomputable (same property as the arbor publisher rebuild fix). Decode it on
screen so they see there's no magic — Sign1 plus an MMR inclusion proof.

**4a. Self-create the receipt — no operator call:**

```bash
# The log store R2 bucket is PUBLIC read-only (Cloudflare R2 managed r2.dev
# domain, enabled in forest-1 log-storage terraform) — so massif tiles and
# checkpoints are fetched straight from the bucket, no operator API. NOT
# /api/forest/... (canopy-api serves no raw blob route). Objects are keyed
# v2/merklelog/{massifs,checkpoints}/{massifHeight}/{logId}/{massifIndex}.{log,sth}
# with a zero-padded 16-hex massifIndex; massifHeight is the forest's config (14).
export LOG_STORE_URL="https://pub-d7bc2e23615b4cd1a80a0944c3cd3507.r2.dev"   # forest-dev-5-logs r2.dev
export MASSIF_H=14 MASSIF_IDX=0000000000000000
curl -sS "$LOG_STORE_URL/v2/merklelog/massifs/$MASSIF_H/$DATA_LOG_ID/$MASSIF_IDX.log"     -o massif.log
curl -sS "$LOG_STORE_URL/v2/merklelog/checkpoints/$MASSIF_H/$DATA_LOG_ID/$MASSIF_IDX.sth" -o checkpoint.sth

forestrie create-receipt \
  --massif massif.log --checkpoint checkpoint.sth \
  --mmr-index 0 \
  --out receipt.selfserve.cbor
```

Note: the `r2.dev` host is the bucket's managed public domain (per lane); the
forest-1 `log_storage_bucket_public_url` output currently emits the *S3* endpoint
(auth-only), so read the actual `r2.dev` domain from the bucket's managed-domain
config, or front it with a stable custom domain before the talk.

> The one public receipt path canopy-api **does** serve (the operator-issued
> receipt this self-serve receipt reproduces byte-for-byte) is
> `GET /logs/{bootstrapLogId}/{logId}/{massifHeight}/entries/{entryIdHex}/receipt`
> — confirmed in `canopy-api` (`index.ts` route group 2 → `resolveReceipt`). That
> endpoint is a *convenience*; 4a's whole point is deriving the same receipt
> without it, from the massif tile alone.

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

**The bridge to Step 5 (say it here):** there are two verification modes, both
riding the signed peak. Offline against the cached checkpoint (this step's
closer) checks the COSE signature against the trusted ES256 sealer key *and*
recomputes the peak from the path — you can cache that checkpoint forever, no
revocation, because the sealer key was gatekept when the peak reached the public
record. Public-record verification (Step 5) drops the signature check entirely
and just recomputes the peak against the accumulator on the public record —
**this is the externalised split-view check itself**: checking the peak against
the public record *substitutes for* checking the signer, so trust reduces to the
public record, never the operator.

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
- **The crux of "pipe, not store":** SCITT + COSE Receipts + the MMR profile separate **sequencing** (the operator) from **auditing/monitoring** and **split-view protection** (externalised to the public record)
- Why it works is the profile: it signs **peaks**, so verifying a peak against the public record substitutes for checking the signer — the operator never carries non-equivocation and is therefore **fungible**: many logs (and many public-record instances) can share one operator, switching is trivial
- Stop trusting the operator? You need **nothing** from it — last massif blob + the checkpoint on the public record = keep issuing and verifying forever
- Public-record verify: recompute the peak, match the accumulator on the public record — **no signature needed**
- Residual trust is small and explicit — **your own log key** + the **public record** (bootstrapper not censoring your publish rights); **never the operator**

**Speaker notes:** The finale, and the crux of the whole "pipe" argument. The
key move rides the MMR profile: because the checkpoint signs **peaks**, checking
a peak against the public record substitutes for checking the signer — so
**split-view protection is externalised from the operator to the public
record**, and the operator never carries non-equivocation. That's what makes it
a genuine pipe: it only sequences, and it's fungible — **many logs and many
public-record instances can point at the same operator**, so switching operators
is trivial and you need nothing from any one of them to keep verifying. Then be
honest about what trust *does* remain, so the claim doesn't ring hollow: you own
the log key, you trust the **public record** (a single global view for
non-equivocation, and the bootstrapper not to censor your publish rights) — an
externalised assumption, not an operator one. Verification collapses to
recomputing a peak and checking it's in the accumulator on the public record
(the checkpoint signer was already gatekept when the peak was published, so you
drop the signature entirely). Answer Q3 on the way past: control of your signing
key is the delegation bound — the
`delegate` beats (Robert delegates the root in Preflight R4; David delegates his
auth and data logs in Step 2, each before its first write) are where each owner
verified the custodian's vouched sealer key against the pinned registrar key and
pre-authorized it to publish; the operator still only sequences. A self-hosted
owner who signs their own checkpoints needs no delegation at all.

**5a. Verify the receipt's peak against the accumulator on the public record**
(no operator, only the public record — `verify` reads `logState(bytes32)` over
JSON-RPC and asserts the receipt's peak is one of the anchored accumulator
peaks):

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

**5b. (OPTIONAL — in your pocket, if a chain-savvy attendee asks.) Watch the
accumulator advance on the public record** — split-view protection made
concrete. This is "here's the bulletin board, if you want to see it", not an
on-stage blockchain showcase. Each `CheckpointPublished` event is *one gated
advance* of a log's accumulator, admitted only after the consistency proof
verifies, under a single global view. Pull them straight from the Base Sepolia
indexer (`eth_getLogs`) — no operator, no forestrie service. `topics[0]` is
`keccak256("CheckpointPublished(bytes32,bytes32,bytes,address,bytes8,uint8,uint64,bytes32[],uint64,bytes32[])")`;
`logId`/`grantLogId`/`rootKey` are the indexed topics, and `size` (the MMR size
after the checkpoint) is the 4th word of `data`.

```bash
# DEPLOY_BLOCK captured at R1: hex block of the deploy tx (bounds the scan).
export CHECKPOINT_TOPIC="0x156942b408823cb05a16027962ea485fa7171d99779ee04094280b2569482426"
curl -sS -X POST "$RPC_URL" -H 'Content-Type: application/json' --data '{
  "jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{
    "address":"'"$UNIVOCITY_ADDRESS"'","fromBlock":"'"$DEPLOY_BLOCK"'","toBlock":"latest",
    "topics":["'"$CHECKPOINT_TOPIC"'"]}]}' \
| node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const L=JSON.parse(d).result||[];console.log(L.length,"checkpoint(s) anchored on-chain:");L.forEach(l=>{const w=i=>l.data.slice(2+i*64,2+(i+1)*64);console.log("  block",parseInt(l.blockNumber,16),"logId",l.topics[1].slice(0,18)+"…","kind",parseInt(w(2),16)===1?"AUTH":"DATA","mmrSize",BigInt("0x"+w(3)).toString(),"tx",l.transactionHash.slice(0,12)+"…")})}'
```

Example output (**real capture** — a fresh forest's first few checkpoints):

```
4 checkpoint(s) anchored on-chain:
  block 44153759 logId 0x0000000000000000… kind AUTH mmrSize 1 tx 0xc82337546f…
  block 44153784 logId 0x0000000000000000… kind AUTH mmrSize 3 tx 0x4d49539793…
  block 44154235 logId 0x0000000000000000… kind AUTH mmrSize 3 tx 0xea645fd94b…
  block 44154928 logId 0x0000000000000000… kind AUTH mmrSize 4 tx 0xa8b5eb3cae…
```

The `mmrSize` marching up (1 → 3 → 4) is the accumulator advancing under a
single global view — the exact thing that makes a checkpoint impossible to show
two ways. (Also in your pocket: `cast call "$UNIVOCITY_ADDRESS"
"logState(bytes32)" <logId>` reads the *current* anchored accumulator for one
log; this reads the *history* of advances.)

**5c. The whole audience verifies, offline, forever** — run **the single
closer** one last time. Land the closing line:

> "The operator was only ever a pipe — split-view protection and the trust that
> matters live on the public record, not the operator. Cache the checkpoint
> forever, self-serve your receipts, swap operators at will, and walk away.
> **It's a pipe, not a store.**"

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
