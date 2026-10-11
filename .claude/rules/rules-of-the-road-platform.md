# Platform rules of the road — moved

Moved to `forestrie/protocol`:
**[`rules/platform.md`](https://github.com/forestrie/protocol/blob/main/rules/platform.md)**
(rule-id anchors `P1`–`P16` preserved at the new location — see the table
below).

Rule → link:

| Rule | Link |
|---|---|
| P1 | [Pipe, not store](https://github.com/forestrie/protocol/blob/main/rules/platform.md#p1--pipe-not-store) |
| P2 | [Receipts verify offline, key-free, forever](https://github.com/forestrie/protocol/blob/main/rules/platform.md#p2--receipts-verify-offline-key-free-forever) |
| P3 | [Keep the four trust questions separate](https://github.com/forestrie/protocol/blob/main/rules/platform.md#p3--keep-the-four-trust-questions-separate) |
| P4 | [Non-equivocation is enforced by the immutable contract, not watchers](https://github.com/forestrie/protocol/blob/main/rules/platform.md#p4--non-equivocation-is-enforced-by-the-immutable-contract-not-watchers) |
| P5 | [On-chain is the amortised anchor, never the hot path](https://github.com/forestrie/protocol/blob/main/rules/platform.md#p5--on-chain-is-the-amortised-anchor-never-the-hot-path) |
| P6 | [Authority is receipt-based; submission is permissionless](https://github.com/forestrie/protocol/blob/main/rules/platform.md#p6--authority-is-receipt-based-submission-is-permissionless) |
| P7 | [Payment grants authority; a grant is a prepaid provability entitlement](https://github.com/forestrie/protocol/blob/main/rules/platform.md#p7--payment-grants-authority-a-grant-is-a-prepaid-provability-entitlement) |
| P8 | [Grants are irrevocable; capacity ends by exhaustion or non-renewal](https://github.com/forestrie/protocol/blob/main/rules/platform.md#p8--grants-are-irrevocable-capacity-ends-by-exhaustion-or-non-renewal) |
| P9 | [Append-only, forward authority only](https://github.com/forestrie/protocol/blob/main/rules/platform.md#p9--append-only-forward-authority-only) |
| P10 | [Grant verification is three-part and non-substitutable](https://github.com/forestrie/protocol/blob/main/rules/platform.md#p10--grant-verification-is-three-part-and-non-substitutable) |
| P11 | [Identity is a separate, key-derived layer](https://github.com/forestrie/protocol/blob/main/rules/platform.md#p11--identity-is-a-separate-key-derived-layer) |
| P12 | [Signed is not sequenced](https://github.com/forestrie/protocol/blob/main/rules/platform.md#p12--signed-is-not-sequenced) |
| P13 | [Absence is first-class, but succinct absence is not free yet](https://github.com/forestrie/protocol/blob/main/rules/platform.md#p13--absence-is-first-class-but-succinct-absence-is-not-free-yet) |
| P14 | [One instance root, set once; global logId→R uniqueness](https://github.com/forestrie/protocol/blob/main/rules/platform.md#p14--one-instance-root-set-once-global-logidr-uniqueness) |
| P15 | [Published artifacts declare their own cache policy; completeness decides immutability](https://github.com/forestrie/protocol/blob/main/rules/platform.md#p15--published-artifacts-declare-their-own-cache-policy-completeness-decides-immutability) |
| P16 | [Conformant COSE/CBOR everywhere; `@forestrie/encoding` owns the wire layer](https://github.com/forestrie/protocol/blob/main/rules/platform.md#p16--conformant-cosecbor-everywhere-forestrieencoding-owns-the-wire-layer) |

Repo files that specialise these rules remain in
[README.md](https://github.com/forestrie/forestrie-agents/blob/main/rules-of-the-road/README.md).
