/**
 * Wire grant payload equals on-chain {@link Grant}: CBOR map keys **1–6** only (v0).
 * No separate `version` (implicit v0), `signer`, `kind`, `exp`, or `nbf` on the wire—
 * issuer attestation for statement signers lives in committed **`grantData`** only.
 */

import type { Grant } from "./grant.js";

/** Alias: transparent-statement payload / decoded grant map. */
export type GrantAssembly = Grant;

/** POST /logs/{logId}/grants body (grant content keys 1–6). */
export type GrantRequest = Grant;
