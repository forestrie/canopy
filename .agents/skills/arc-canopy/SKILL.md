---
name: arc-canopy
description: Canopy domain glossary (SCRAPI edge). Use when a task touches the SCRAPI API, Workers, x402, or delegation DOs.
when_to_use: "Workers, SCRAPI routes, SequencingQueue DO, R2, Queues, x402, delegation APIs, Playwright e2e."
user-invocable: false
---

# arc-context: canopy (SCRAPI edge)

Minimal glossary for **canopy** — Cloudflare Workers SCRAPI API, ingress DOs,
x402 settlement, delegation coordinator.

**Load when:** Workers, SCRAPI routes, SequencingQueue DO, R2, Queues, x402,
delegation APIs, Playwright e2e.

**Do not bulk-read** — use [canopy/AGENTS.md](https://github.com/forestrie/canopy/blob/main/AGENTS.md) and [docs/agents/](https://github.com/forestrie/canopy/tree/main/docs/agents).

---

## Core terms

| Term | Meaning |
|------|---------|
| **SCRAPI** | SCITT-compatible HTTP API for transparency logs |
| **canopy-api** | Main Worker (`@canopy/api`, port 8789 locally) |
| **forestrie-ingress** | Worker hosting SequencingQueue Durable Objects (8791) |
| **SequencingQueue DO** | Per-log sequencing; assigns seq numbers; ranger pulls |
| **x402 settlement** | Payment-gated register-statement flow (`@canopy/x402-settlement`) |
| **delegation-coordinator** | Phase 3 delegation APIs, sharded DO (8793) |
| **contentHash** | SHA-256 of statement payload; async status via 303 |
| **CBOR responses** | Default wire format except `/api/health` and scitt-configuration |

## Authoritative docs

| Topic | Path |
|-------|------|
| Agent router | [AGENTS.md](https://github.com/forestrie/canopy/blob/main/AGENTS.md) |
| E2E / Doppler | [docs/agents/e2e.md](https://github.com/forestrie/canopy/blob/main/docs/agents/e2e.md) |
| Grant verification map | [docs/arc/canopy-grant-verification-implementation.md](https://github.com/forestrie/canopy/blob/main/docs/arc/canopy-grant-verification-implementation.md) |
| Fee accounts / metering | [devdocs ADR-0059](https://github.com/forestrie/devdocs/blob/main/archive/2607/adr/adr-0059-instance-root-fee-accounts.md) — every univocity instance root is its own fee account; supersedes the ancestry-walk model |
| Onboard grant APIs & fee tracing | [devdocs ARC-0026](https://github.com/forestrie/devdocs/blob/main/archive/2607/arc/arc-0026-onboard-grant-apis-and-fee-tracing.md) |
| x402 architecture (historical) | [devdocs ARC-0015](https://github.com/forestrie/devdocs/blob/main/archive/2601/arc/arc-0015-x402-settlement-architecture.md) — SUPERSEDED; progression in the [payments theme index](https://github.com/forestrie/devdocs/blob/main/archive/INDEX-payments-fees.md) |
| System testing | [devdocs ARC-0024](https://github.com/forestrie/devdocs/blob/main/arc/arc-0024-system-testing-architecture.md) |

## Platform cross-links

| Domain | Where |
|--------|-------|
| Sequencing / signing (GKE) | [arc-arbor](../arc-arbor/SKILL.md) |
| On-chain checkpoints | [arc-univocity](../arc-univocity/SKILL.md) |
| Grant verification model | [devdocs ARC-0019](https://github.com/forestrie/devdocs/blob/main/archive/2603/arc/arc-0019-grant-verification-model.md) |
| MMR / COSE receipts | [draft-bryce-cose-receipts-mmr-profile](https://github.com/robinbryce/draft-bryce-cose-receipts-mmr-profile) |

## Gotchas

- Start **both** `@canopy/api` and `@canopy/forestrie-ingress` for DO routes locally
- Local secrets: `packages/apps/canopy-api/.dev.vars` — not repo-root `.env`
- E2E: Doppler project **canopy** outside npm scripts (see e2e-local-doppler rule)
- **A window-less delegation entry is not malformed — it means *you* choose the
  bounds.** ADR-0050 §2: the pending-delegation listing is uniform; every entry
  is "a key you may delegate to", carrying a window for on-demand pendings and
  **none** for the standing delegate key. Signers "handle every entry
  identically", signing over a horizon and TTL of their choosing (conventionally
  `mmrStart = 0`). There is no `kind` discriminator. Skipping or rejecting the
  window-less entry stalls the log: the sealer's coverage-matched lease lookup
  finds nothing covering its seal window and defers forever on `delegation
  material pending`, while pollers that count only *windowed* entries report an
  empty queue — so it reads as sealer slowness, not a signer bug. Advance
  submissions must also carry the compact **on-chain signature**, or the lease
  has no `OnchainProof` and the publisher cannot publish that log's checkpoints.
  Two independent signers (the e2e kit and the mandate agent) each made this
  exact defensive mistake, so treat it as a trap, not an edge case.
