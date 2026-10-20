/**
 * Where an MMR inclusion walk ends. A leaf hash
 * (`SHA-256(idtimestamp ‖ inner)`) does not commit the leaf's position, and
 * a path of length 0 commits nothing more, so matching a recomputed peak by
 * VALUE alone leaves the receipt's claimed `mmrIndex` unbound. Requiring the
 * matched accumulator peak to sit at the node index the walk reaches binds
 * it: interior nodes commit their position (`H(pos ‖ left ‖ right)`), and
 * an empty path must start at the peak itself.
 *
 * Mirrors the position arithmetic of `calculateRoot` in
 * [@forestrie/merklelog](https://github.com/forestrie/canopy/blob/main/packages/merklelog/src/mmr/algorithms.ts)
 * (go-merklelog `mmr/proof.go`), without hashing.
 */
import { indexHeight } from "@forestrie/merklelog";

/**
 * The zero-based MMR index of the node an inclusion path of `pathLength`
 * siblings reaches from `leafMmrIndex`: the peak the path claims to prove.
 */
export function inclusionWalkEndIndex(
  leafMmrIndex: bigint,
  pathLength: number,
): bigint {
  let height = indexHeight(leafMmrIndex);
  // 1-based position, as calculateRoot tracks it.
  let pos = leafMmrIndex + 1n;
  for (let i = 0; i < pathLength; i++) {
    // `indexHeight(pos)` is the height of the node AFTER the current one:
    // higher means the current node is a right child.
    if (indexHeight(pos) > height) {
      pos += 1n;
    } else {
      pos += 2n << BigInt(height);
    }
    height += 1;
  }
  return pos - 1n;
}
