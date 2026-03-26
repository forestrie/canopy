/**
 * Register-statement auth: the Forestrie-Grant must be a **data-log** checkpoint grant whose
 * **`grantData`** (on-chain committed bytes) binds the allowed **statement signer** (COSE `kid`).
 * Wire **v0** carries no duplicate `signer` (obsolete key 7); **`grantData`** is the issuer
 * attestation in the commitment preimage.
 */

import type { Grant } from "./grant.js";
import { grantDataToBytes } from "./grant-data.js";
import {
  hasCreateAndExtend,
  isDataLogStatementGrantFlags,
} from "./grant-flags.js";

/**
 * True when the 8-byte `grant` bitmap authorizes register-statement auth:
 *
 * - **Data log:** {@link isDataLogStatementGrantFlags} (GF_DATA_LOG + extend capability), or
 * - **Root auth bootstrap / checkpoint grant:** GF_AUTH_LOG only in the low class byte, with
 *   **GF_CREATE \| GF_EXTEND** — `grantData` binds the checkpoint/statement signer (same
 *   commitment rule as data-log grants).
 */
export function isStatementRegistrationGrant(grant: Grant): boolean {
  const g = grant.grant as Uint8Array;
  if (isDataLogStatementGrantFlags(g)) return true;
  if (g.length < 8) return false;
  const low = g[7] ?? 0;
  const authOnly = (low & 0x03) === 0x01;
  return authOnly && hasCreateAndExtend(g);
}

/**
 * @deprecated Use {@link isStatementRegistrationGrant}; kept for transitional imports.
 */
export const isPublishCheckpointStatementAuthGrant =
  isStatementRegistrationGrant;

/**
 * Bytes to compare (equality) against the statement COSE `kid`.
 *
 * Always derived from **`grantData`** only. If **grantData** is **64** bytes (ES256 **x||y**),
 * the binding is the **first 32 bytes (x)** so a standard **32-byte `kid`** matches typical
 * secp256r1 usage. Otherwise the full **grantData** bytes are used (e.g. **32-byte** kid id).
 */
export function statementSignerBindingBytes(grant: Grant): Uint8Array {
  const gd = grantDataToBytes(grant.grantData);
  if (gd.length === 64) return gd.subarray(0, 32);
  return gd;
}
