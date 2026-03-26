/**
 * Parsed receipt (root + inclusion proof) from a SCITT transparent statement (Plan 0005).
 */

import type { Proof } from "@canopy/merklelog";

export interface ParsedReceipt {
  root: Uint8Array;
  proof: Proof;
}
