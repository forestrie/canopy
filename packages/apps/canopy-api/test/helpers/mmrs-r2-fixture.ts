/**
 * Minimal v2 MMRS checkpoint + massif blobs for buildReceiptForEntry tests.
 * Layout mirrors scrapi-flow.test.ts / resolve-receipt.ts (massif height 3).
 */

import { encodeCborDeterministic } from "@forestrie/encoding";
import { DELEGATION_CERT_LABEL } from "../../src/grant/delegation-verify.js";

export const SEAL_PEAK_RECEIPTS_LABEL = -65931;

const VALUE_BYTES = 32;
const RESERVED_HEADER_SLOTS = 7;
const INDEX_HEADER_BYTES = 32;
const MAX_MMR_HEIGHT = 64;
const BLOOM_BITS_PER_ELEMENT_V1 = 10;
const BLOOM_FILTERS = 4;
const BLOOM_HEADER_BYTES_V1 = 32;
const URKLE_FRONTIER_STATE_V1_BYTES = 544;
const URKLE_LEAF_RECORD_BYTES = 128;
const URKLE_NODE_RECORD_BYTES = 64;

export function formatMassifObjectIndex(massifIndex: bigint): string {
  return massifIndex.toString(10).padStart(16, "0");
}

export function mmrsCheckpointKey(
  logId: string,
  massifHeight: number,
  massifIndex: bigint,
): string {
  return `v2/merklelog/checkpoints/${massifHeight}/${logId}/${formatMassifObjectIndex(massifIndex)}.sth`;
}

export function mmrsMassifKey(
  logId: string,
  massifHeight: number,
  massifIndex: bigint,
): string {
  return `v2/merklelog/massifs/${massifHeight}/${logId}/${formatMassifObjectIndex(massifIndex)}.log`;
}

/**
 * Build v2 massif bytes with `logHashes[i]` at MMR log index i (32-byte nodes).
 */
export function buildV2MassifBytes(opts: {
  massifHeight: number;
  massifIndex: number;
  logHashes: Uint8Array[];
}): Uint8Array {
  const { massifHeight, massifIndex, logHashes } = opts;
  const leafCount = 1 << (massifHeight - 1);
  const mBits = BLOOM_BITS_PER_ELEMENT_V1 * leafCount;
  const bitsetBytes = Math.ceil(mBits / 8);
  const bloomRegionBytes = BLOOM_HEADER_BYTES_V1 + BLOOM_FILTERS * bitsetBytes;
  const bloomBitsetsBytes = bloomRegionBytes - BLOOM_HEADER_BYTES_V1;
  const leafTableBytes = leafCount * URKLE_LEAF_RECORD_BYTES;
  const nodeStoreBytes = (2 * leafCount - 1) * URKLE_NODE_RECORD_BYTES;
  const indexDataBytes =
    bloomBitsetsBytes +
    URKLE_FRONTIER_STATE_V1_BYTES +
    leafTableBytes +
    nodeStoreBytes;

  const fixedHeaderEnd = VALUE_BYTES + VALUE_BYTES * RESERVED_HEADER_SLOTS;
  const trieHeaderEnd = fixedHeaderEnd + INDEX_HEADER_BYTES;
  const peakStackStart = trieHeaderEnd + indexDataBytes;
  const logStart = peakStackStart + MAX_MMR_HEIGHT * VALUE_BYTES;

  const logEntries = logHashes.length;
  const massifBytes = new Uint8Array(logStart + logEntries * VALUE_BYTES);
  const view = new DataView(massifBytes.buffer);

  view.setBigUint64(8, 0n, false);
  view.setUint16(21, 2, false);
  view.setUint32(23, 1, false);
  massifBytes[27] = massifHeight;
  view.setUint32(28, massifIndex, false);

  for (let i = 0; i < logHashes.length; i++) {
    const h = logHashes[i]!;
    if (h.length !== 32) {
      throw new Error(`logHashes[${i}] must be 32 bytes`);
    }
    massifBytes.set(h, logStart + i * VALUE_BYTES);
  }

  return massifBytes;
}

/** Raw peak receipt COSE Sign1 (no header 396); detached nil payload. */
export function encodePeakReceiptCoseSign1(
  protectedHeader: Uint8Array,
  unprotected: Map<number, unknown>,
  signature: Uint8Array,
): Uint8Array {
  return cborBytes([protectedHeader, unprotected, null, signature]);
}

export function buildV2CheckpointBytes(opts: {
  mmrSize: bigint;
  peakReceipts: Uint8Array[];
  delegationCert?: Uint8Array;
}): Uint8Array {
  // Checkpoint format v3 (ADR-0046): detached (null) payload; the sealed
  // size travels as tree-size-2 of the consistency proof under the
  // verifiable-proofs unprotected header (draft-bryce: label 396, key -2,
  // `bstr .cbor [tree-size-1, tree-size-2, paths, right-peaks]`).
  const consistencyProof = cborBytes([0n, opts.mmrSize, [], []]);
  const verifiableProofs = new Map<number, unknown>([[-2, consistencyProof]]);
  const checkpointUnprotected = new Map<number, unknown>([
    [396, verifiableProofs],
    [SEAL_PEAK_RECEIPTS_LABEL, opts.peakReceipts],
  ]);
  if (opts.delegationCert?.length) {
    checkpointUnprotected.set(DELEGATION_CERT_LABEL, opts.delegationCert);
  }
  const emptyProtected = new Uint8Array();
  const emptySig = new Uint8Array();
  return cborBytes([emptyProtected, checkpointUnprotected, null, emptySig]);
}

export async function putMmrsFixture(
  bucket: R2Bucket,
  opts: {
    logId: string;
    massifHeight: number;
    massifIndex?: bigint;
    mmrSize: bigint;
    logHashes: Uint8Array[];
    peakReceipts: Uint8Array[];
    delegationCert?: Uint8Array;
  },
): Promise<{ checkpointKey: string; massifKey: string }> {
  const massifIndex = opts.massifIndex ?? 0n;
  const massifIndexNum = Number(massifIndex);
  const checkpointKey = mmrsCheckpointKey(
    opts.logId,
    opts.massifHeight,
    massifIndex,
  );
  const massifKey = mmrsMassifKey(opts.logId, opts.massifHeight, massifIndex);
  await bucket.put(
    checkpointKey,
    buildV2CheckpointBytes({
      mmrSize: opts.mmrSize,
      peakReceipts: opts.peakReceipts,
      delegationCert: opts.delegationCert,
    }),
  );
  await bucket.put(
    massifKey,
    buildV2MassifBytes({
      massifHeight: opts.massifHeight,
      massifIndex: massifIndexNum,
      logHashes: opts.logHashes,
    }),
  );
  return { checkpointKey, massifKey };
}

function cborBytes(value: unknown): Uint8Array {
  const encoded = encodeCborDeterministic(value);
  return encoded instanceof Uint8Array
    ? encoded
    : new Uint8Array(encoded as ArrayLike<number>);
}

/** go-merklelog/mmr/peaks.go — matches resolve-receipt peak receipt selection. */
export function peaksBitmap(mmrSize: bigint): bigint {
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

function bitLength(num: bigint): number {
  if (num === 0n) return 0;
  return num.toString(2).length;
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

function peakIndex(leafCount: bigint, d: number): number {
  const peaksMask = (1n << BigInt(d + 1)) - 1n;
  const n = popcount64(leafCount & peaksMask);
  const a = popcount64(leafCount);
  return a - n;
}

export function peakIndexForLeafProof(
  mmrSize: bigint,
  proofLen: number,
): number {
  return peakIndex(peaksBitmap(mmrSize), proofLen);
}

/** Size `peakIndex + 1`; only index `peakIndex` needs a real signed receipt. */
export function buildPeakReceiptSlots(
  peakIndex: number,
  signedReceipt: Uint8Array,
): Uint8Array[] {
  const slots: Uint8Array[] = [];
  const empty = encodePeakReceiptCoseSign1(
    new Uint8Array(),
    new Map(),
    new Uint8Array(),
  );
  for (let i = 0; i <= peakIndex; i++) {
    slots.push(i === peakIndex ? signedReceipt : empty);
  }
  return slots;
}
