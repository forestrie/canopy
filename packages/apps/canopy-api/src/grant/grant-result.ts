/**
 * Result of decoding a SCITT transparent statement (Plan 0005): {@link Grant} from payload;
 * idtimestamp from unprotected header -65537 only; receipt from header 396.
 */

import type { Grant } from "./grant.js";
import type { ParsedReceipt } from "./parsed-receipt.js";

export interface GrantResult {
  /** Decoded grant (v0 wire: keys 1–6 only). */
  grant: Grant;
  /** 8-byte big-endian idtimestamp from header -65537 (zeros when absent, e.g. bootstrap). */
  idtimestamp: Uint8Array;
  receipt?: ParsedReceipt;
  /** Raw transparent statement bytes (for bootstrap COSE verify, etc.). */
  bytes: Uint8Array;
}
