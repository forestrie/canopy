/**
 * Helpers for resolving sequencing results (resolveContent + idtimestamp from massif).
 * Used by query-registration-status and serve-grant (Plan 0004 subplan 03).
 */

import {
  leafCountForMassifHeight,
  massifIndexFromLeafIndex,
  mmrIndex,
  urkleLeafTableStartByteOffset,
  v2MassifObjectKey,
} from "@forestrie/merklelog";

/** Leaf record size in bytes (from Urkle.LeafRecordBytes). */
const LEAF_RECORD_BYTES = 128;

/** ID timestamp size in bytes (first 8 bytes of leaf record). */
export const IDTIMESTAMP_BYTES = 8;

/**
 * MMR index of a leaf (go-merklelog mmr.MMRIndex), for the entry id. Takes
 * the number leafIndex resolveContent returns.
 */
export function mmrIndexFromLeafIndex(leafIndex: number): bigint {
  return mmrIndex(BigInt(leafIndex));
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
