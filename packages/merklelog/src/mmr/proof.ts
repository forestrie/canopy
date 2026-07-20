/**
 * MMR proof building (pure, store-agnostic).
 *
 * Ports the proof-side arithmetic from go-merklelog `mmr/proof.go` and
 * `mmr/peaks.go`. These were previously inline-duplicated in
 * canopy-api `resolve-receipt.ts` and receipt-verify `build-receipt-offline.ts`;
 * this is the single hoisted home (plan-2607-15 §4, phase 2).
 *
 * All arithmetic is BigInt and free of node builtins so the package stays
 * browser-safe (ADR-0048). Function names mirror the go-merklelog originals.
 */

/** Reads the 32-byte node at MMR index `i` from some backing store. */
export type NodeGetter = (i: bigint) => Uint8Array;

/** Number of bits needed to represent `num` (0 for 0). */
function bitLength(num: bigint): number {
  if (num <= 0n) return 0;
  return num.toString(2).length;
}

/** True when `num > 0` and its binary form is all ones. */
function allOnes(num: bigint): boolean {
  return num > 0n && (num & (num + 1n)) === 0n;
}

/**
 * Jump left to the leftmost node at the same height.
 * (go-merklelog `mmr/indexheight.go` JumpLeftPerfect)
 */
function jumpLeftPerfect(pos: bigint): bigint {
  const bl = bitLength(pos);
  if (bl === 0) return pos;
  const msb = 1n << BigInt(bl - 1);
  return pos - (msb - 1n);
}

/**
 * Height of a 1-based position.
 * (go-merklelog `mmr/indexheight.go` PosHeight)
 */
function posHeight(pos: bigint): number {
  // Positions are 1-based; `pos <= 0` is out of domain and would spin forever
  // (`jumpLeftPerfect(0) === 0`, `allOnes(0) === false`). Reject in bounded
  // time so a malformed size fed to any caller (peakMMRIndexes, indexHeight,
  // inclusionProof, …) fails loudly instead of hanging the verifier (FOR-414).
  if (pos <= 0n) {
    throw new Error(`posHeight: position must be >= 1, got ${pos}`);
  }
  let current = pos;
  while (!allOnes(current)) {
    current = jumpLeftPerfect(current);
  }
  return bitLength(current) - 1;
}

/**
 * Zero-based height index of the node at MMR index `i` (leaves are 0).
 * (go-merklelog `mmr/indexheight.go` IndexHeight)
 */
export function indexHeight(i: bigint): number {
  return posHeight(i + 1n);
}

/**
 * Witness path (siblings, ascending) for the node at MMR index `i` in the tree
 * ending at `mmrLastIndex`. Terminates at the covering peak.
 * (go-merklelog `mmr/proof.go` InclusionProof)
 *
 * @throws if `i > mmrLastIndex`.
 */
export function inclusionProof(
  get: NodeGetter,
  mmrLastIndex: bigint,
  i: bigint,
): Uint8Array[] {
  if (i > mmrLastIndex) {
    throw new Error("index out of range");
  }
  let g = BigInt(indexHeight(i));
  const proof: Uint8Array[] = [];
  // iSibling out of range guarantees loop termination.
  for (;;) {
    const siblingOffset = 2n << g;
    let iSibling: bigint;
    if (BigInt(indexHeight(i + 1n)) > g) {
      // right sibling
      iSibling = i - siblingOffset + 1n;
      i += 1n;
    } else {
      // left sibling
      iSibling = i + siblingOffset - 1n;
      i += siblingOffset;
    }
    if (iSibling > mmrLastIndex) {
      return proof;
    }
    proof.push(get(iSibling));
    g += 1n;
  }
}

/**
 * Peaks bitmap for an MMR size: the numeric value equals the leaf count of the
 * largest valid MMR with size <= `mmrSize`; each set bit marks a perfect
 * subtree (peak). (go-merklelog `mmr/peaks.go` PeaksBitmap)
 */
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

/** Population count of a non-negative BigInt. */
function popcount(x: bigint): number {
  let count = 0;
  let v = x;
  while (v > 0n) {
    if ((v & 1n) === 1n) count += 1;
    v >>= 1n;
  }
  return count;
}

/**
 * Accumulator slot (left-to-right) committed by an inclusion proof of length
 * `proofLen` in a tree of size `mmrSize`. (server resolve-receipt.ts:735,
 * equivalent to go `mmr.PeakIndex(LeafCount(mmrSize), proofLen)`)
 */
export function peakIndexForLeafProof(
  mmrSize: bigint,
  proofLen: number,
): number {
  const leafCount = peaksBitmap(mmrSize);
  const peaksMask = (1n << BigInt(proofLen + 1)) - 1n;
  return popcount(leafCount) - popcount(leafCount & peaksMask);
}

/** Largest peak size <= size of the tree ending at index `i`. (go `mmr/peaks.go` TopPeak) */
function topPeak(i: bigint): bigint {
  const bl = bitLength(i + 2n);
  return (1n << BigInt(bl - 1)) - 2n;
}

/**
 * MMR indices of the peaks of the tree ending at `mmrIndex` (inclusive),
 * ascending. Empty when `mmrIndex + 1` is not a valid MMR size (siblings
 * without a parent). (go-merklelog `mmr/peaks.go` Peaks)
 */
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

/**
 * Smallest complete MMR size that contains the node at MMR index `mmrIndex`.
 * (go-merklelog `mmr/firstmmrsize.go` FirstMMRSize)
 */
export function firstMMRSize(mmrIndex: bigint): bigint {
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

/**
 * Massif index (0-based) that holds the node at MMR index `i` for a log of the
 * given massif height. (go-merklelog `massifs/massifindex.go` MassifIndexFromMMRIndex)
 */
export function massifIndexFromMMRIndex(
  massifHeight: number,
  i: bigint,
): bigint {
  const size = firstMMRSize(i);
  const leafIndex = peaksBitmap(size) - 1n;
  const massifMaxLeaves = 1n << BigInt(massifHeight - 1);
  return leafIndex / massifMaxLeaves;
}

/**
 * Map from ancestor-peak MMR index to peak-stack slot for the massif whose
 * first MMR index is `firstIndex`. Nodes below `firstIndex` resolve through the
 * fixed peak-stack region via this map.
 * (go-merklelog `massifs/peakstack.go` PeakStackMap)
 */
export function peakStackMap(
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
