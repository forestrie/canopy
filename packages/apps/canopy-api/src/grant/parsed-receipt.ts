/**
 * Parsed receipt (peak + inclusion proof) from a SCITT transparent statement (Plan 0005).
 */

import type { Proof } from "@canopy/merklelog";

export interface ParsedReceipt {
  /**
   * Raw receipt COSE Sign1 bytes as embedded in transparent statement header 396.
   * Required for receipt Sign1 signature verification.
   */
  coseSign1Bytes: Uint8Array;
  /**
   * MMR peak hash from the receipt Sign1 payload when present (32 bytes).
   * `null` when the receipt uses a COSE detached payload (MMRIVER peak receipts
   * from go-merklelog signEmptyPeakReceipt); verification then derives the peak
   * from the leaf hash and proof.
   */
  explicitPeak: Uint8Array | null;
  proof: Proof;
}
