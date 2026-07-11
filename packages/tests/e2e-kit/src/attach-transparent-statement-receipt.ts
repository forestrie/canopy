/**
 * Attach resolve-receipt bytes and idtimestamp to SCITT transparent statement
 * unprotected headers (Plan 0005).
 */
import { mergeUnprotectedIntoCoseSign1 } from "@forestrie/encoding";
import { HEADER_IDTIMESTAMP, HEADER_RECEIPT } from "@forestrie/grant-builder";

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
