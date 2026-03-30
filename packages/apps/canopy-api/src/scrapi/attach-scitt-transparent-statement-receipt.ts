/**
 * Assemble SCITT transparent statement after sequencing: attach resolve-receipt
 * bytes and idtimestamp to unprotected headers (Plan 0005). COSE merge is generic
 * (@canopy/encoding); header labels are Forestrie profile.
 */

import { mergeUnprotectedIntoCoseSign1 } from "@canopy/encoding";
import {
  HEADER_IDTIMESTAMP,
  HEADER_RECEIPT,
} from "../grant/transparent-statement.js";

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
