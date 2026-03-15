/**
 * Grant result decoded from a SCITT transparent statement (Plan 0005, Plan 0006).
 * Grant from payload (content only); idtimestamp from unprotected header -65537 only; receipt from header 396.
 */

import type { Grant } from "./grant.js";
import type { ParsedReceipt } from "./parsed-receipt.js";

/**
 * Grant result decoded from a SCITT transparent statement (Plan 0005).
 * Receipt is optional for bootstrap grant (no inclusion check); required when inclusionEnv is set.
 * Idtimestamp is from header -65537 (8 bytes); required for receipt verification when inclusion is required.
 */
export interface GrantResult {
  grant: Grant;
  /** Idtimestamp from unprotected header -65537 (8-byte bstr). Required for receipt verification. */
  idtimestamp?: Uint8Array;
  /** Omitted for bootstrap grant (pre-sequencing); required for inclusion verification. */
  receipt?: ParsedReceipt;
  bytes?: Uint8Array;
}
