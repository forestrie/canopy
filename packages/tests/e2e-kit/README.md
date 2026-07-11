# @forestrie/canopy-e2e-kit

Reusable Playwright helpers extracted from `@canopy/api-e2e` for cross-repo
system tests ([ARC-0024](https://github.com/forestrie/devdocs/blob/main/arc/arc-0024-system-testing-architecture.md)).

## Testing tiers (ARC-0024)

| Tier   | Scope                                              | Univocity                 | CI entry                                                   |
| ------ | -------------------------------------------------- | ------------------------- | ---------------------------------------------------------- |
| **T2** | Component bootstrap (ephemeral Imutable provision) | `deploy provision e2e`    | `tests-system.yml` `e2e_tier=t2`                           |
| **T3** | Component system + lane integration                | Pinned manifest contracts | Canopy `e2e_tier=t3` (default); `forestrie/system-testing` |

Kit exports `parseE2eTestingTier` / `isEphemeralBootstrapTier` from `e2e-testing-tier.ts`.
Set `E2E_TESTING_TIER=t2` locally to mirror T2 bootstrap preflight.

Cross-repo lane specs (forest genesis, Mode B/C registration, BYOK) run in
**`forestrie/system-testing`** — not `tests-system.yml`.

## Version slices

### 0.1.0 — Phase 2 minimum

- Coordinator env guards (`hasCoordinatorApiE2eEnv`, `assertCoordinatorApiE2eEnv`)
- Onboard token mint (`mintOnboardTokenE2e`)
- Registration/receipt polling (`pollQueryRegistrationUntilReceiptRedirect`, `pollResolveReceiptUntil200`, `sequencingBackoff`)

### 0.2.0 — Genesis slice

- Univocity chain-binding (`univocityProvisionSkipReason`, `fetchOnChainBootstrapConfig`, bootstrap contract helpers)
- Forest genesis POST helpers (`ensureForestGenesisEs256E2e`, `ensureForestGenesisKs256E2e`, `genesisBodyEs256`)
- Bootstrap variants (`E2E_BOOTSTRAP_VARIANTS`, `describeForEachBootstrapVariant`)
- Root/child grant mint and sign (`mintBootstrapGrant`, `signChildGrantUnderRoot`, ES256 PEM + KS256 wallet signers)
- Registration through receipt (`completeGrantRegistrationThroughReceipt`, `completeBootstrapGrantWithReceipt`, `buildCompletedGrantBase64`)
- Coordinator delegation loop (`setupBootstrapCoordinatorDelegation`, `pollBootstrapRegistrationThroughReceipt`)
- E2E env guards (`assertBootstrapMintE2eEnv`, `assertBootstrapReceiptE2eEnv`, `assertSystemE2eEnv`)
- Minimal wire types (`Grant`, transparent-statement header labels) and COSE encoding vendored under `src/wire/` and `src/encoding/`

### 0.3.0 — Mode C slice (includes 0.2.0)

- Mode C webhook ingress/tunnel/seal (`startModeCWebhookIngress`, `pollModeCWebhookSealThroughReceipt`, `modeCWebhookSealSkipReason`)
- Wallet challenge session (`exchangeWalletChallengeSessionE2e`)
- Custodian HTTP helpers (`custodianApiV1BaseUrl`, `postCustodianApiSignPayload`, custody grant builders)
- Post-entries helpers (`postEntriesExpectAccepted`, etc.)
- `mode-c-webhook-receiver` (in-process webhook receiver for coordinator e2e)

## Install

Same GitHub Packages auth as `@forestrie/delegation-cose` — local installs need
`gh auth refresh -h github.com -s read:packages`.

Workspace consumers: `"@forestrie/canopy-e2e-kit": "workspace:*"`.

Peer dependencies: `@playwright/test`, `viem` (wallet challenge session).

## Build

```bash
pnpm --filter @forestrie/canopy-e2e-kit build
pnpm --filter @forestrie/canopy-e2e-kit test
```

Publish tags (GitHub Packages):

- **Repo release:** `vMAJOR.MINOR.PATCH` (e.g. `v0.3.2`) — kit version matches tag.
- **Kit-only:** `canopy-e2e-kit-v*` (legacy / independent kit bumps).

Workflow: `.github/workflows/publish-canopy-e2e-kit.yml` (also runs on canopy
`release.yaml` `v*` tags).

Published dependency: `@forestrie/delegation-cose` `^0.1.1` (GitHub Packages;
`workspace:^` in monorepo, rewritten on `pnpm publish`).

## Wire / encoding sync policy

Kit vendors a minimal subset of `@forestrie/encoding` and grant wire types under
`src/encoding/` and `src/wire/`. When changing canopy-api grant or COSE paths,
update the kit copy in the **same PR** and bump the kit semver slice.

| Kit path            | Canonical source                       |
| ------------------- | -------------------------------------- |
| `src/encoding/*`    | `packages/shared/encoding/src/`        |
| `src/wire/grant/*`  | `packages/apps/canopy-api/src/grant/`  |
| `src/wire/forest/*` | `packages/apps/canopy-api/src/forest/` |
| `src/wire/cose/*`   | `packages/apps/canopy-api/src/cose/`   |

Drift guard: `test/merge-cose-sign1-unprotected.test.ts` mirrors
`@forestrie/encoding` golden vectors for `mergeUnprotectedIntoCoseSign1`.

Manifest placeholder: `KS256_UNIVOCITY_MANIFEST_PLACEHOLDER` in
`system-test-manifest-constants.ts` — keep aligned with
`system-testing/manifests/lane-a.example.yaml`.

Moved helpers live in this package; `packages/tests/canopy-api/tests/utils/*.ts`
files re-export from `@forestrie/canopy-e2e-kit` so Playwright specs keep
`@e2e-utils/*` import paths unchanged.
