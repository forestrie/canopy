/**
 * PeakStackEnd calculation for v2 massif format
 */

import { LogFormat } from "./logformat.js";
import { indexDataBytesV2, leafCountForMassifHeight } from "./indexformat.js";

/**
 * PeakStackEnd returns the first byte after the massif ancestor peak stack data
 *
 * The peak stack is fixed at MaxMmrHeight entries regardless of how many are
 * actually needed. This makes it possible to trivially compute the node &
 * leaf counts knowing only the byte size of the massif.
 *
 * V2 layout:
 *   StartHeader (256 bytes)
 *   IndexHeader (32 bytes) = BloomHeaderV1
 *   IndexData (bloom bitsets + frontier + leaf table + node store)
 *   PeakStack (MaxMmrHeight * ValueBytes = 2048 bytes)
 *
 * @param massifHeight - One-based massif height
 * @returns Byte offset of the end of the peak stack
 */
export function peakStackEnd(massifHeight: number): bigint {
  const fixedHeaderEnd = BigInt(LogFormat.StartHeaderSize);
  const indexHeaderBytes = BigInt(LogFormat.IndexHeaderBytes);

  const leafCount = leafCountForMassifHeight(massifHeight);
  const indexDataBytes = indexDataBytesV2(leafCount);

  const peakStackSize = BigInt(LogFormat.MaxMmrHeight * LogFormat.ValueBytes);

  return fixedHeaderEnd + indexHeaderBytes + indexDataBytes + peakStackSize;
}
