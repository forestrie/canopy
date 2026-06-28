# @forestrie/canopy-e2e-kit

Reusable Playwright helpers extracted from `@canopy/api-e2e` for cross-repo
system tests ([ARC-0024](https://github.com/forestrie/devdocs/blob/main/arc/arc-0024-system-testing-architecture.md)).

## Phase 2 minimum slice

- Coordinator env guards
- Onboard token mint (ops admin)
- Registration/receipt polling helpers

## Install

Same GitHub Packages auth as `@forestrie/delegation-cose` — local installs need
`gh auth refresh -h github.com -s read:packages`.

## Build

```bash
pnpm --filter @forestrie/canopy-e2e-kit build
pnpm --filter @forestrie/canopy-e2e-kit test
```

Publish tag: `canopy-e2e-kit-v*`.
