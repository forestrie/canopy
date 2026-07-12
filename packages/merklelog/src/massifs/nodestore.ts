/**
 * Massif blob node access for MMR proof building.
 *
 * A v2 massif `.log` blob is self-sufficient for any leaf→peak inclusion path
 * whose leaf lives in that massif: local nodes give the in-massif siblings and
 * the fixed ancestor peak stack gives everything older (plan-2607-15 §1.1).
 * Node lookup is pure arithmetic — `LogStart + (i − firstIndex)·32` for local
 * nodes, `peakStackMap` for ancestors.
 *
 * Ported from the inline copies in canopy-api `resolve-receipt.ts` and
 * receipt-verify `build-receipt-offline.ts` (plan-2607-15 §4, phase 2).
 * Browser-safe: pure buffer arithmetic, no node builtins (ADR-0048).
 */

import { Massif } from "./massif.js";
import { LogFormat } from "./logformat.js";
import { peakStackEnd } from "./peakstackend.js";
import { peakStackMap } from "../mmr/proof.js";

const VALUE_BYTES = BigInt(LogFormat.ValueBytes); // 32
const MAX_MMR_HEIGHT = BigInt(LogFormat.MaxMmrHeight); // 64

/** Node access over a single massif blob. */
export interface MassifNodeStore {
  /** 32-byte node at MMR index `i` (log region for `i >= firstIndex`, else the ancestor peak stack). */
  get(i: bigint): Uint8Array;
  massifHeight: number;
  massifIndex: bigint;
  firstIndex: bigint;
  /** Last MMR index with log data in this blob. */
  lastIndex: bigint;
}

function slice32(buf: Uint8Array, offset: bigint, label: string): Uint8Array {
  if (offset < 0n || offset + VALUE_BYTES > BigInt(buf.byteLength)) {
    throw new Error(
      `out of range read for ${label}: off=${offset.toString(10)}`,
    );
  }
  const start = Number(offset);
  return buf.slice(start, start + Number(VALUE_BYTES));
}

/**
 * Open a v2 massif blob for MMR node reads. Nodes below `firstIndex` resolve
 * through the ancestor peak stack; nodes above `lastIndex` are not present in
 * this blob and throw when requested.
 */
export function openMassifNodeStore(massifBytes: Uint8Array): MassifNodeStore {
  const massif = new Massif(massifBytes);
  const start = massif.getStart();
  const massifHeight = start.massifHeight;
  if (
    !Number.isInteger(massifHeight) ||
    massifHeight < 1 ||
    massifHeight > LogFormat.MaxMmrHeight
  ) {
    throw new Error(`massif header has invalid height ${massifHeight}`);
  }
  const massifIndex = BigInt(start.massifIndex);
  const firstIndex = start.firstIndex;

  const logStart = peakStackEnd(massifHeight);
  const peakStackStart = logStart - MAX_MMR_HEIGHT * VALUE_BYTES;
  const blobLen = BigInt(massifBytes.byteLength);
  if (blobLen < logStart) {
    throw new Error("massif blob too short for v2 layout");
  }
  const logNodeCount = (blobLen - logStart) / VALUE_BYTES;
  const lastIndex = firstIndex + logNodeCount - 1n;

  const stackMap = peakStackMap(massifHeight, firstIndex);

  const get = (i: bigint): Uint8Array => {
    if (i >= firstIndex) {
      if (i > lastIndex) {
        throw new Error(
          `mmr index ${i.toString(10)} is beyond this massif's log data ` +
            `(last ${lastIndex.toString(10)}); local content does not cover ` +
            `the requested tree size`,
        );
      }
      const off = logStart + (i - firstIndex) * VALUE_BYTES;
      return slice32(massifBytes, off, "log-data");
    }
    const peakIdx = stackMap.get(i);
    if (peakIdx === undefined) {
      throw new Error(`missing ancestor peak for mmr index ${i.toString(10)}`);
    }
    const off = peakStackStart + BigInt(peakIdx) * VALUE_BYTES;
    return slice32(massifBytes, off, "peak-stack");
  };

  return { get, massifHeight, massifIndex, firstIndex, lastIndex };
}
