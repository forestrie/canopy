/**
 * Attach resolve-receipt bytes and idtimestamp to SCITT transparent statement
 * unprotected headers (Plan 0005). Deterministic receipt construction moved
 * from @forestrie/canopy-e2e-kit (plan-2607-12 Phase 2, FOR-353).
 *
 * Golden vectors for receipt construction/verification are tracked by
 * FOR-289.
 */
import { mergeUnprotectedIntoCoseSign1 } from "@forestrie/encoding";
import { HEADER_IDTIMESTAMP } from "./forest-genesis-labels.js";

/** SCITT transparent statement unprotected receipt label (grants.md §3.2). */
export const HEADER_RECEIPT = 396;

export function attachReceiptAndIdtimestampToTransparentStatement(
  statementBytes: Uint8Array,
  receiptCborBytes: Uint8Array,
  idtimestampBe8: Uint8Array,
): Uint8Array {
  if (idtimestampBe8.length !== 8) {
    throw new Error("idtimestamp must be 8 bytes (big-endian)");
  }
  return mergeUnprotectedIntoCoseSign1(
    statementBytes,
    new Map<number, unknown>([
      [HEADER_RECEIPT, receiptCborBytes],
      [HEADER_IDTIMESTAMP, idtimestampBe8],
    ]),
  );
}
