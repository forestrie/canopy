/**
 * Self-created SCITT receipts from local artifacts.
 *
 * Mirrors canopy-api resolve-receipt receipt assembly, but over local massif
 * (`.log`) and checkpoint (`.sth`) bytes instead of R2 objects. The checkpoint
 * signature covers only the accumulator, so the inclusion path is free to
 * rebuild client-side: read massif nodes, build the leaf→peak path, attach it
 * at header 396 to the checkpoint's pre-signed peak receipt. The result is
 * byte-compatible with an API-issued receipt.
 *
 * `computeAccumulatorPeak` supports the chain-anchored variant: build the path
 * at an externally attested tree size (e.g. Univocity `logState` on Base
 * Sepolia) and compare the computed peak with the published accumulator.
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import {
  calculateRoot,
  Massif,
  peakStackEnd,
  type Proof,
} from "@canopy/merklelog";
import {
  requireCoseSign1,
  toHeaderMap,
  unwrapCoseSign1Tag,
  type CoseSign1,
} from "./parse-receipt.js";
import { SubtleHasher } from "./subtle-hasher.js";

const VDS_COSE_RECEIPT_PROOFS_TAG = 396;
const SEAL_PEAK_RECEIPTS_LABEL = -65931;
const DELEGATION_CERT_LABEL = 1000;
const VDP_CONSISTENCY_PROOF_KEY = -2;

const VALUE_BYTES = 32n;
const MAX_MMR_HEIGHT = 64n;

export type MassifNodeStore = {
  /** 32-byte node at MMR index `i` (log data or ancestor peak stack). */
  get(i: bigint): Uint8Array;
  massifHeight: number;
  massifIndex: bigint;
  firstIndex: bigint;
  /** Last MMR index with log data in this massif blob. */
  lastIndex: bigint;
};

/**
 * Open a v2 massif blob for MMR node reads. Nodes below `firstIndex` resolve
 * through the ancestor peak stack; nodes above `lastIndex` are not present in
 * this blob and throw.
 */
export function openMassifNodeStore(massifBytes: Uint8Array): MassifNodeStore {
  const massif = new Massif(massifBytes);
  const start = massif.getStart();
  const massifHeight = start.massifHeight;
  if (
    !Number.isInteger(massifHeight) ||
    massifHeight < 1 ||
    massifHeight > 64
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

  const stackMap = peakStackMapForMassif(massifHeight, firstIndex);

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

export type ParsedCheckpoint = {
  coseSign1: CoseSign1;
  unprotected: Map<number, unknown>;
  /** Pre-signed peak receipts (label -65931), or null when absent. */
  peakReceipts: unknown[] | null;
  /** Sealed tree size (tree-size-2 of the embedded consistency proof). */
  mmrSize: bigint | null;
  delegationCert: Uint8Array | null;
};

/** Parse a format-v3 checkpoint (`.sth`) COSE Sign1. */
export function parseCheckpoint(checkpointBytes: Uint8Array): ParsedCheckpoint {
  const decoded = decodeCbor(checkpointBytes) as unknown;
  const coseSign1 = requireCoseSign1(unwrapCoseSign1Tag(decoded));
  const unprotected = toHeaderMap(coseSign1[1]);

  const peakReceiptsRaw = unprotected.get(SEAL_PEAK_RECEIPTS_LABEL);
  const peakReceipts = Array.isArray(peakReceiptsRaw) ? peakReceiptsRaw : null;

  const delegationCertRaw = unprotected.get(DELEGATION_CERT_LABEL);
  const delegationCert =
    delegationCertRaw instanceof Uint8Array && delegationCertRaw.length > 0
      ? delegationCertRaw
      : null;

  return {
    coseSign1,
    unprotected,
    peakReceipts,
    mmrSize: sealedSizeFromCheckpoint(unprotected),
    delegationCert,
  };
}

export type BuildReceiptOfflineInput = {
  massifBytes: Uint8Array;
  checkpointBytes: Uint8Array;
  mmrIndex: bigint;
};

/**
 * Assemble a receipt for the entry at `mmrIndex` from a local massif blob and
 * its checkpoint. Pure over bytes; no network, no signing key — the signature
 * is the checkpoint's pre-signed peak receipt. Throws with a specific reason
 * on any failure.
 */
export function buildReceiptOffline(
  input: BuildReceiptOfflineInput,
): Uint8Array {
  const { mmrIndex } = input;
  if (mmrIndex < 0n) {
    throw new Error("mmrIndex must be non-negative");
  }

  const checkpoint = parseCheckpoint(input.checkpointBytes);
  if (!checkpoint.peakReceipts) {
    throw new Error(
      "checkpoint carries no pre-signed peak receipts (label -65931)",
    );
  }
  if (checkpoint.mmrSize === null || checkpoint.mmrSize <= 0n) {
    throw new Error(
      "checkpoint carries no consistency proof (cannot determine sealed size)",
    );
  }
  const mmrSize = checkpoint.mmrSize;
  const mmrLastIndex = mmrSize - 1n;
  if (mmrIndex > mmrLastIndex) {
    throw new Error(
      `checkpoint does not cover entry: mmrIndex ${mmrIndex.toString(10)} ` +
        `>= sealed size ${mmrSize.toString(10)}`,
    );
  }

  const store = openMassifNodeStore(input.massifBytes);
  const expectedMassifIndex = massifIndexFromMMRIndex(
    store.massifHeight,
    mmrIndex,
  );
  if (expectedMassifIndex !== store.massifIndex) {
    throw new Error(
      `entry at mmrIndex ${mmrIndex.toString(10)} lives in massif ` +
        `${expectedMassifIndex.toString(10)}, but this blob is massif ` +
        `${store.massifIndex.toString(10)}`,
    );
  }

  const proof = inclusionProof(store.get, mmrLastIndex, mmrIndex);
  const peakIdx = peakIndexForLeafProof(mmrSize, proof.length);
  const receiptBytes = checkpoint.peakReceipts[peakIdx];
  if (!(receiptBytes instanceof Uint8Array)) {
    throw new Error(
      `checkpoint peak receipt slot ${peakIdx} is missing or not bstr`,
    );
  }

  const receiptSign1 = requireCoseSign1(
    unwrapCoseSign1Tag(decodeCbor(receiptBytes) as unknown),
  );
  const receiptUnprotected = toHeaderMap(receiptSign1[1]);

  if (checkpoint.delegationCert) {
    receiptUnprotected.set(DELEGATION_CERT_LABEL, checkpoint.delegationCert);
  }

  const inclusionProofEntry = new Map<number, unknown>([
    [1, mmrIndex],
    [2, proof],
  ]);
  const verifiableProofs = new Map<number, unknown>([
    [-1, [inclusionProofEntry]],
  ]);
  receiptUnprotected.set(VDS_COSE_RECEIPT_PROOFS_TAG, verifiableProofs);

  // Peak receipts are signed with detached payload; emit nil so verify uses
  // the peak derived from the inclusion proof.
  const assembled: CoseSign1 = [
    receiptSign1[0],
    receiptUnprotected,
    null,
    receiptSign1[3],
  ];
  return cborBytes(assembled);
}

export type ComputedAccumulatorPeak = {
  /** Root computed from the massif's leaf value and rebuilt path. */
  peak: Uint8Array;
  /** Position of that peak in the accumulator, left to right. */
  peakIndex: number;
  proof: Uint8Array[];
  leafValue: Uint8Array;
};

/**
 * Chain-anchored variant: rebuild the inclusion path for `mmrIndex` at an
 * externally attested tree size and compute the accumulator peak it commits
 * to. Compare `peak` with `accumulator[peakIndex]` published by the Univocity
 * contract (`logState`). Requires the local massif to hold nodes up to
 * `mmrSize`.
 */
export async function computeAccumulatorPeak(opts: {
  massifBytes: Uint8Array;
  mmrIndex: bigint;
  mmrSize: bigint;
}): Promise<ComputedAccumulatorPeak> {
  const { mmrIndex, mmrSize } = opts;
  if (mmrSize <= 0n || mmrIndex >= mmrSize) {
    throw new Error(
      `mmrIndex ${mmrIndex.toString(10)} is not covered by tree size ` +
        `${mmrSize.toString(10)} (entry not anchored yet?)`,
    );
  }
  const store = openMassifNodeStore(opts.massifBytes);
  const leafValue = store.get(mmrIndex);
  const path = inclusionProof(store.get, mmrSize - 1n, mmrIndex);
  const proof: Proof = { path, mmrIndex };
  const peak = await calculateRoot(
    new SubtleHasher(),
    leafValue,
    proof,
    mmrIndex,
  );
  return {
    peak,
    peakIndex: peakIndexForLeafProof(mmrSize, path.length),
    proof: path,
    leafValue,
  };
}

// --- helpers ---

function cborBytes(value: unknown): Uint8Array {
  const encoded = encodeCbor(value);
  return encoded instanceof Uint8Array
    ? encoded
    : new Uint8Array(encoded as ArrayLike<number>);
}

function slice32(buf: Uint8Array, offset: bigint, label: string): Uint8Array {
  if (offset < 0n || offset + 32n > BigInt(buf.byteLength)) {
    throw new Error(
      `out of range read for ${label}: off=${offset.toString(10)}`,
    );
  }
  const start = Number(offset);
  return buf.slice(start, start + 32);
}

/**
 * Sealed mmr size from a format-v3 checkpoint: tree-size-2 of the consistency
 * proof (`bstr .cbor [tree-size-1, tree-size-2, paths, right-peaks]`) under
 * the verifiable-proofs unprotected header (label 396, key -2).
 */
function sealedSizeFromCheckpoint(
  unprotected: Map<number, unknown>,
): bigint | null {
  const vdpRaw = unprotected.get(VDS_COSE_RECEIPT_PROOFS_TAG);
  if (vdpRaw === undefined || vdpRaw === null) return null;
  const vdp = toHeaderMap(vdpRaw as Map<number, unknown>);
  const proofBstr = vdp.get(VDP_CONSISTENCY_PROOF_KEY);
  if (!(proofBstr instanceof Uint8Array)) return null;
  const proof = decodeCbor(proofBstr) as unknown;
  if (!Array.isArray(proof) || proof.length < 2) return null;
  const treeSize2 = proof[1];
  if (typeof treeSize2 === "bigint") return treeSize2;
  if (typeof treeSize2 === "number" && Number.isSafeInteger(treeSize2)) {
    return BigInt(treeSize2);
  }
  return null;
}

// --- MMR index math (ported from go-merklelog/mmr, mirrors resolve-receipt) ---

function bitLength(num: bigint): number {
  if (num === 0n) return 0;
  return num.toString(2).length;
}

function allOnes(num: bigint): boolean {
  return num > 0n && (num & (num + 1n)) === 0n;
}

function jumpLeftPerfect(pos: bigint): bigint {
  const bl = bitLength(pos);
  if (bl === 0) return pos;
  const msb = 1n << BigInt(bl - 1);
  return pos - (msb - 1n);
}

function posHeight(pos: bigint): number {
  let current = pos;
  while (!allOnes(current)) {
    current = jumpLeftPerfect(current);
  }
  return bitLength(current) - 1;
}

function indexHeight(i: bigint): number {
  return posHeight(i + 1n);
}

function inclusionProof(
  getNode: (i: bigint) => Uint8Array,
  mmrLastIndex: bigint,
  i: bigint,
): Uint8Array[] {
  if (i > mmrLastIndex) {
    throw new Error("index out of range");
  }
  let g = BigInt(indexHeight(i));
  const proof: Uint8Array[] = [];
  while (true) {
    const siblingOffset = 2n << g;
    let iSibling: bigint;
    if (BigInt(indexHeight(i + 1n)) > g) {
      iSibling = i - siblingOffset + 1n;
      i += 1n;
    } else {
      iSibling = i + siblingOffset - 1n;
      i += siblingOffset;
    }
    if (iSibling > mmrLastIndex) {
      return proof;
    }
    proof.push(getNode(iSibling));
    g += 1n;
  }
}

function peaksBitmap(mmrSize: bigint): bigint {
  if (mmrSize === 0n) return 0n;
  let pos = mmrSize;
  let peakSize = (1n << BigInt(bitLength(mmrSize))) - 1n;
  let peakMap = 0n;
  while (peakSize > 0n) {
    peakMap <<= 1n;
    if (pos >= peakSize) {
      pos -= peakSize;
      peakMap |= 1n;
    }
    peakSize >>= 1n;
  }
  return peakMap;
}

function popcount64(x: bigint): number {
  let count = 0;
  let v = x;
  while (v > 0n) {
    if ((v & 1n) === 1n) count += 1;
    v >>= 1n;
  }
  return count;
}

function peakIndexForLeafProof(mmrSize: bigint, proofLen: number): number {
  const leafCount = peaksBitmap(mmrSize);
  const peaksMask = (1n << BigInt(proofLen + 1)) - 1n;
  return popcount64(leafCount) - popcount64(leafCount & peaksMask);
}

function topPeak(i: bigint): bigint {
  const bl = bitLength(i + 2n);
  return (1n << BigInt(bl - 1)) - 2n;
}

/** MMR indices of the peaks of the tree ending at `mmrIndex` (inclusive). */
export function peakMMRIndexes(mmrIndex: bigint): bigint[] {
  let mmrSize = mmrIndex + 1n;
  if (posHeight(mmrSize + 1n) > posHeight(mmrSize)) {
    return [];
  }
  let peak = 0n;
  const out: bigint[] = [];
  while (mmrSize !== 0n) {
    const peakSize = topPeak(mmrSize - 1n) + 1n;
    peak = peak + peakSize;
    out.push(peak - 1n);
    mmrSize -= peakSize;
  }
  return out;
}

function peakStackMapForMassif(
  massifHeight: number,
  firstIndex: bigint,
): Map<bigint, number> {
  const map = new Map<bigint, number>();
  const iPeaks = peakMMRIndexes(firstIndex);
  for (let i = 0; i < iPeaks.length; i++) {
    const ip = iPeaks[i]!;
    if (indexHeight(ip) < massifHeight - 1) {
      continue;
    }
    map.set(ip, i);
  }
  return map;
}

function mmrIndexFromLeafIndex(leafIndex: bigint): bigint {
  let sum = 0n;
  let current = leafIndex;
  while (current > 0n) {
    const h = BigInt(bitLength(current));
    sum += (1n << h) - 1n;
    const half = 1n << (h - 1n);
    current -= half;
  }
  return sum;
}

function firstMMRSize(mmrIndex: bigint): bigint {
  let i = mmrIndex;
  let h0 = indexHeight(i);
  let h1 = indexHeight(i + 1n);
  while (h0 < h1) {
    i += 1n;
    h0 = h1;
    h1 = indexHeight(i + 1n);
  }
  return i + 1n;
}

function massifIndexFromMMRIndex(
  massifHeight: number,
  mmrIndex: bigint,
): bigint {
  const size = firstMMRSize(mmrIndex);
  const leafIndex = peaksBitmap(size) - 1n;
  const massifMaxLeaves = 1n << BigInt(massifHeight - 1);
  return leafIndex / massifMaxLeaves;
}
