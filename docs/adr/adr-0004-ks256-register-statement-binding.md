# KS256 register-statement binding and verify dispatch

Register-statement verifies KS256 statements when `grantData` is a **20-byte
Ethereum address**: the statement COSE `kid` must equal that address (full
`grantData`), and signature verification uses Keccak `Sig_structure` + ecrecover
(EOA) or ERC-1271 (contract wallet via `UNIVOCITY_CONTRACT_RPC_URL`). The handler
selects ES256 vs KS256 verify from **grantData length** (64 vs 20), not from a
self-describing `alg` label in the statement protected header. Statement headers
remain kid-only `{4: kid}` for both algs; adding `{1: alg}` uniformly is tracked
in [FOR-74](https://linear.app/forestrie/issue/FOR-74). See
[plan-0033](../plans/plan-0033-ks256-register-statement.md) and
[arc-statement-cose-encoding §8](../arc/arc-statement-cose-encoding.md).
