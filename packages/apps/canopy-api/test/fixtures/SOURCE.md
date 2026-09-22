# Source: grant vectors

`grant_vectors.json` and `grant_vectors_negative.json` are vendored,
byte-for-byte, from
[forestrie/protocol](https://github.com/forestrie/protocol)'s
`vectors/fixtures/`, which is the single source of truth for the grant wire
vectors (FOR-580; see
[protocol#4](https://github.com/forestrie/protocol/pull/4),
`vectors/grant-and-leaf-format.md`). Do not hand-edit either file — re-vendor
from protocol and update the pins below. Both files are listed in
`.prettierignore` (byte-for-byte vendored copy, same as
`checkpoint-receipt-kat39.json`) — `pnpm check` must not reformat them.

Pinned at protocol commit
[`89ffbcf`](https://github.com/forestrie/protocol/commit/89ffbcfb4359148fafd49552ae8bd85a57faeff5)
(`plan-2609-09/phase-1-vectors`, protocol#4, unmerged as of FOR-580):

| File                          | SHA-256                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `grant_vectors.json`          | `03ef03ebc39e5582041f87d4457b99faec54e1851274f9429c198b741908cdb8` |
| `grant_vectors_negative.json` | `f5d388ca020c67d73c70318b65be2e1f901342edbad867b1147765e624621996` |

`grant_vectors.json` is byte-identical to the copy this repo already carried
before FOR-580 — protocol#4's claim that its positive vectors match canopy's
existing fixture holds.

`grant_vectors_negative.json` is new: each row is keys 0–6 plus one or both
of the retired keys 7 (`signer`) / 8 (`kind`), and `must_reject: true` with
`reason: "obsolete_key"`. Consumed by
`packages/apps/canopy-api/test/grant-format.test.ts` and
`packages/libs/receipt-verify/test/grant-vectors.test.ts` (the latter reads
this copy via a relative path rather than vendoring a second one, matching
the pattern in `packages/libs/receipt-verify/test/checkpoint-receipt-kat39.test.ts`).
