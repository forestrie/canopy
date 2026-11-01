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
 * Compute MMR index from leaf index (go-merklelog/mmr/mmrindex.go MMRIndex).
 */
export function mmrIndexFromLeafIndex(leafIndex: number): bigint {
  let sum = 0n;
  let current = BigInt(leafIndex);

  while (current > 0n) {
    const h = BigInt(current.toString(2).length);
    sum += (1n << h) - 1n;
    const half = 1n << (h - 1n);
    current -= half;
  }

  return sum;
}

/**
 * Read the idtimestamp for a leaf entry using an efficient byte-range request.
 *
 * The massif and the leaf's position in it both come from `leafIndex` and
 * the one-based `massifHeight` (2^(h-1) leaves per massif), the same
 * arithmetic go-merklelog uses when ranger commits the massif. Nothing
 * here trusts a massif index stored elsewhere.
 */
export async function readIdtimestampFromMassif(
  r2: R2Bucket,
  logId: string,
  massifHeight: number,
  leafIndex: number,
): Promise<bigint> {
  const massifIndex = massifIndexFromLeafIndex(massifHeight, leafIndex);
  const leavesPerMassif = Number(leafCountForMassifHeight(massifHeight));
  const leafOrdinal = leafIndex % leavesPerMassif;

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
