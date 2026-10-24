# Provenance — `session-key-endorsement-v2-real-authenticator.json`

A v2 session-key endorsement (ADR-0065 §3) captured from a **real platform
authenticator**, plus one per-turn leaf signed by the endorsed session key
with the endorsement at unprotected label `-65801`. It closes devdocs
plan-2608-14 step 1.3. The synthetic suites build their assertions in-test;
this fixture pins what a real device emits.

## What produced it

|          |                                                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo     | [`forestrie/thinker`](https://github.com/forestrie/thinker) — public, MIT                                                                                                                                           |
| Commit   | `e5f941c` (thinker `main`, 2026-10-24)                                                                                                                                                                              |
| Harness  | `apps/scribe-ui/src/lib/goldens.ts` (`createCaptureIdentity` then `captureEndorsementGolden`, added in thinker#13), driven from the dev-only `/goldens` page                                                        |
| Command  | `pnpm install && pnpm dev:ui` at the thinker repo root, open `http://localhost:5173/goldens` in Safari, step 1 (create throwaway passkey), step 3 (capture v2 session-key endorsement), "Download endorsement JSON" |
| Captured | 2026-10-24T11:59:41.880Z, Safari 26.2 / macOS Touch ID, origin `http://localhost:5173`, rpId `localhost`, flags UP\|UV\|BE\|BS                                                                                      |
| sha256   | `711f6f90548924ac59447e17d94a4c7a63d8666dff27381e6ad01d97d6fc9220`                                                                                                                                                  |

The passkey and the session key are throwaways created for the capture. The
validity window (`1790000000000` to `1790604800000`, unix ms) is the fixed
window the synthetic suites use, so tests pass an explicit clock rather than
the wall clock.

## Consumers

- `test/session-key-endorsement-real-authenticator-golden.test.ts`
  (`verifySessionKeyEndorsement`, challenge binding, window, leaf extraction
  and signature).
- `packages/apps/canopy-api/test/endorsed-signer-real-authenticator-golden.test.ts`
  (`resolveEndorsedStatementSigner`, canopy's admission resolver).

## Regeneration is an owner ceremony, and is never byte-identical

Nothing about this fixture changes per release. Re-capture only when the
endorsement wire format changes, which would be a protocol change. A
re-capture differs from this one in the challenge, signature,
`clientDataJSON`, session key and leaf by construction, so do not treat
that diff as a regression. When you replace the fixture, update the
commit, timestamp and sha256 above.
