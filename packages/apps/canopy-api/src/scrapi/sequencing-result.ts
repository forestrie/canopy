/**
 * Helpers for resolving sequencing results (resolveContent + idtimestamp from massif).
 * Used by query-registration-status and serve-grant (Plan 0004 subplan 03).
 */

import {
  leafCountForMassifHeight,
  massifIndexFromLeafIndex,
  urkleLeafTableStartByteOffset,
  v2MassifObjectKey,
} from "@forestrie/merklelog";

/** Leaf record size in bytes (from Urkle.LeafRecordBytes). */
const LEAF_RECORD_BYTES = 128;

/** ID timestamp size in bytes (first 8 bytes of leaf record). */
export const IDTIMESTAMP_BYTES = 8;

/**
 * Read the idtimestamp for a leaf entry using an efficient byte-range request.
 *
 * The massif and the leaf's position in it both come from `leafIndex` and
 * the one-based `massifHeight` (2^(h-1) leaves per massif), the same
 * arithmetic go-merklelog uses when ranger commits the massif. Nothing
 * here trusts a massif index stored elsewhere.
 *
 * @param leafIndex - uint64 leaf index from the SequencingQueue's
 *   resolveContent; only the in-massif ordinal is narrowed to a number.
 */
export async function readIdtimestampFromMassif(
  r2: R2Bucket,
  logId: string,
  massifHeight: number,
  leafIndex: bigint,
): Promise<bigint> {
  const massifIndex = massifIndexFromLeafIndex(massifHeight, leafIndex);
  const leafOrdinal = Number(
    leafIndex % leafCountForMassifHeight(massifHeight),
  );

  const leafTableStart = urkleLeafTableStartByteOffset(massifHeight);
  const leafRecordOffset = leafTableStart + leafOrdinal * LEAF_RECORD_BYTES;

  const objectKey = v2MassifObjectKey(massifHeight, logId, massifIndex);

  const object = await r2.get(objectKey, {
    range: { offset: leafRecordOffset, length: IDTIMESTAMP_BYTES },
  });

  if (!object) {
    throw new Error(`Massif not found: ${objectKey}`);
  }

  const data = await object.arrayBuffer();
  if (data.byteLength < IDTIMESTAMP_BYTES) {
    throw new Error(
      `Massif range read returned insufficient bytes: ${data.byteLength}`,
    );
  }

  const view = new DataView(data);
  return view.getBigUint64(0, false);
}
