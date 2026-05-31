/**
 * MMR inclusion proof (go-merklelog/mmr/proof.go InclusionProof), for offline tests.
 */

function allOnes(num: bigint): boolean {
  return num > 0n && (num & (num + 1n)) === 0n;
}

function bitLength(num: bigint): number {
  if (num === 0n) return 0;
  return num.toString(2).length;
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

/**
 * Build an inclusion proof path for leaf at MMR index `targetIndex` in a tree
 * whose last index is `mmrLastIndex`. `getHash(i)` returns the 32-byte node at i.
 */
export function inclusionProofForIndex(
  getHash: (mmrIndex: bigint) => Uint8Array,
  mmrLastIndex: bigint,
  targetIndex: bigint,
): Uint8Array[] {
  if (targetIndex > mmrLastIndex) {
    throw new Error("index out of range");
  }

  let i = targetIndex;
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

    proof.push(getHash(iSibling));
    g += 1n;
  }
}
