/**
 * Freshen a stale receipt (FOR-418 Phase 3, plan-2607-32).
 *
 * A receipt goes stale when log growth buries the peak it commits to. Freshening
 * re-anchors it to the CURRENT sealed state without tiles: extend the leaf's
 * inclusion path from its old peak up to the current accumulator using the
 * checkpoint chain's consistency proofs (the tile-free source of the climb
 * nodes), then attach that fresh path at header 396 to the LATEST checkpoint's
 * pre-signed peak receipt. The result is a native receipt about the current
 * state (the calldata provider supplies the climb material tile-free, but the
 * signature/cert always comes from a latest `.sth`; plan-2607-32 Phase 3).
 *
 * Trust note — three orthogonal concerns (see forestrie-cli's TRUST-MODEL.md):
 *  - FRESHNESS is what freshen produces: the extended path recomputes the
 *    current accumulator peak (self-checked below); a caller may additionally
 *    bind that accumulator to a trusted chain read. This is the receipt's
 *    substance.
 *  - SEALING attestation: the emitted receipt necessarily carries the LATEST
 *    checkpoint's signature — its label-1000 owner→sealer delegation cert and
 *    pre-signed peak receipt. A freshened receipt is a NEW attestation of the
 *    current state, so the only signature it can carry is one over a checkpoint
 *    at the current size; attaching any other would be forgery. A rotation of
 *    the delegated-TO sealer key is routine and within the owner's authority, so
 *    freshen does NOT flag it — there is no signer-change gate (this supersedes
 *    the earlier `--allow-new-signer` sketch; plan-2607-32 F2). The old receipt's
 *    cert is irrelevant to the emitted artifact.
 *  - AUTHORITY (does the log chain to genesis) is NOT carried by this signature
 *    and NOT freshen's concern: it is the grant hierarchy, proven by grants + their
 *    inclusion proofs (and enforced on-chain at publish). Downstream `verify`
 *    picks the posture — `--genesis`/`--known-log-key` check the sealer chains to
 *    the owner; the accumulator rungs check freshness directly and treat the
 *    signature as vestigial.
 *
 * Two independent fail-closed guards keep a bad assembly from ever minting:
 *  - Cross-checks against the checkpoint being borrowed from: the supplied
 *    chain must reach the checkpoint's sealed size and fold to exactly the
 *    number of peaks the checkpoint pre-signed (freshen holds no signing key, so
 *    the cryptographic peak↔signature tie stays with downstream verify; these
 *    structural checks turn a chain/checkpoint mismatch into a mint-time error
 *    instead of an unverifiable receipt).
 *  - The path self-check: `calculateRoot(leaf, freshPath)` must equal the
 *    covering peak of the folded latest accumulator.
 *
 * The climb arithmetic is `@forestrie/merklelog`'s `inclusionProofPath` (a
 * tested go-merklelog port); this module only assembles node values by index
 * from the old receipt path + the consistency proofs.
 */
import {
  calculateRoot,
  inclusionProofPath,
  mmrSizeForLeafCount,
  peakIndexForLeafProof,
  peakMMRIndexes,
  peaksBitmap,
} from "@forestrie/merklelog";
import {
  assembleReceiptFromProof,
  parseCheckpoint,
} from "./build-receipt-offline.js";
import {
  CheckpointSignedSizeMismatchError,
  computeCheckpointAccumulator,
  type CheckpointConsistencyProof,
} from "./checkpoint-chain.js";
import { parseReceipt } from "./parse-receipt.js";
import { SubtleHasher } from "./subtle-hasher.js";

/**
 * BREAKING (within the 2.0.0 major already in flight): the sizeless
 * `accumulatorFrom?: Uint8Array[]` seed is replaced by `trustedBase`, which
 * carries the seed's SIZE alongside its peaks. Without a size the fold ran
 * each link against the size read off that link's own proof, which is what
 * {@link computeCheckpointAccumulator} exists to prevent (ADR-0066 D5.4) —
 * a seed could only ever be checked against the peak count the proof's own
 * declared base implies, and many sizes share a peak count.
 */
export type FreshenReceiptInput = {
  /** The stale receipt (COSE Sign1 with a 396 inclusion proof). */
  oldReceiptBytes: Uint8Array;
  /** The leaf's committed value: `SHA-256(idtimestamp ‖ inner)` — the same
   * value `verify` recomputes from the entry (caller derives it). */
  leafValue: Uint8Array;
  /** Consistency-proof chain covering [0 or the trusted base] → the latest
   * sealed size, in ascending contiguous order (the raw per-checkpoint
   * proofs, with `paths`). Every link's `signedTreeSize2` must equal its
   * `treeSize2`, as `checkpointConsistencyProof` requires of the checkpoint
   * it decoded each link from. The chain's last link must end at the
   * checkpoint's sealed size. */
  consistencyProofs: readonly CheckpointConsistencyProof[];
  /** Trusted base for a suffix chain — the size the caller already trusts
   * and that size's accumulator; omit for a chain from base 0 (size 0, an
   * empty accumulator). The size must be a complete MMR size, the
   * accumulator must hold one peak per peak of that size, and the first
   * link's declared `tree-size-1` must equal the size. Same shape as
   * `verifyCheckpointChain`'s `trustedBase`. */
  trustedBase?: { size: bigint; accumulator: Uint8Array[] };
  /** The latest checkpoint (`.sth`): its pre-signed peak receipts + delegation
   * cert become the freshened receipt's signature. */
  latestCheckpointBytes: Uint8Array;
};

export type FreshenReceiptResult = {
  /** The freshened native receipt (verifies against the latest state). */
  receipt: Uint8Array;
  /** Sealed size the freshened receipt is anchored at. */
  sealedSize: bigint;
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i]! ^ b[i]!;
  return x === 0;
}

/**
 * Freshen a stale receipt to the latest sealed state. Throws if a link's
 * signed `tree-size-2` disagrees with its declared one
 * ({@link CheckpointSignedSizeMismatchError}), if the chain is not a
 * contiguous cover from the trusted base to the checkpoint's sealed size, if
 * a climb node is missing from the supplied proofs, or if the recomputed
 * peak does not match the folded latest accumulator.
 */
export async function freshenReceipt(
  input: FreshenReceiptInput,
): Promise<FreshenReceiptResult> {
  const { proof } = parseReceipt(input.oldReceiptBytes);
  // `parseReceipt` addresses the leaf by MMR index (396 proof entry key 1);
  // `inclusionProofPath` below needs exactly that MMR index. (`Proof.leafIndex`
  // is a distinct leaf-ordinal field that parseReceipt never sets — do not use
  // it here, or a future producer that populated it would feed a non-MMR-index
  // into the climb.)
  const leafMmrIndex = proof.mmrIndex;
  if (leafMmrIndex === undefined) {
    throw new Error("receipt inclusion proof carries no mmr index");
  }
  const oldPath = proof.path;

  const latest = parseCheckpoint(input.latestCheckpointBytes);
  if (latest.mmrSize === null || latest.mmrSize <= 0n) {
    throw new Error("latest checkpoint carries no sealed size");
  }
  const sealedSize = latest.mmrSize;
  if (leafMmrIndex >= sealedSize) {
    throw new Error(
      `receipt entry ${leafMmrIndex} is newer than the latest sealed size ${sealedSize}`,
    );
  }

  // --- validate the supplied chain shape before folding (F5) ---
  const links = input.consistencyProofs;
  if (links.length === 0) {
    throw new Error(
      "freshen requires at least one consistency proof linking the receipt's era to the checkpoint",
    );
  }
  const firstLink = links[0]!;
  // Base: the CALLER's trusted size and its accumulator (size 0 and an empty
  // accumulator for a whole-log chain). The size has to be a size an MMR can
  // have — `peaksBitmap` rounds an incomplete one DOWN, so a size of 5 would
  // fold the 4 -> N shape — and the accumulator has to hold that size's
  // peaks, which is the check the proof's own declared base used to stand in
  // for.
  const baseSize = input.trustedBase?.size ?? 0n;
  const baseAccumulator = input.trustedBase?.accumulator ?? [];
  if (
    baseSize < 0n ||
    mmrSizeForLeafCount(peaksBitmap(baseSize)) !== baseSize
  ) {
    throw new Error(`trusted base size ${baseSize} is not a complete MMR size`);
  }
  const basePeaks = baseSize === 0n ? 0 : peakMMRIndexes(baseSize - 1n).length;
  if (baseAccumulator.length !== basePeaks) {
    throw new Error(
      `base accumulator has ${baseAccumulator.length} peaks; trusted base size ${baseSize} has ${basePeaks}`,
    );
  }
  // Every link's SIGNED tree-size-2 must equal its declared one — the same
  // equality `checkpointConsistencyProof` enforces when it decodes a
  // checkpoint (ADR-0066 D1 as amended, D5.5). These links arrive already
  // decoded, so nothing here had re-read the field the type says was pinned
  // to the signature, and a link carrying `signedTreeSize2: 999n` beside
  // `treeSize2: 7n` freshened (review finding I5).
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    if (link.signedTreeSize2 !== link.treeSize2) {
      throw new CheckpointSignedSizeMismatchError(
        `consistency proof ${i}: signed tree-size-2 (-65933) ${link.signedTreeSize2} != declared consistency-proof tree-size-2 ${link.treeSize2}`,
      );
    }
  }
  // The first link must continue from that size, not from a size it names
  // itself (ADR-0066 D5.4).
  if (firstLink.treeSize1 !== baseSize) {
    throw new Error(
      `first consistency proof declares tree-size-1 ${firstLink.treeSize1}; the trusted base size is ${baseSize}`,
    );
  }
  // Contiguity: each link continues where the previous one sealed.
  for (let i = 1; i < links.length; i++) {
    if (links[i]!.treeSize1 !== links[i - 1]!.treeSize2) {
      throw new Error(
        `consistency chain is not contiguous at link ${i}: base ${links[i]!.treeSize1} != previous sealed size ${links[i - 1]!.treeSize2}`,
      );
    }
  }
  // Endpoint: the chain must reach exactly the checkpoint's sealed size (F1).
  const lastLink = links[links.length - 1]!;
  if (lastLink.treeSize2 !== sealedSize) {
    throw new Error(
      `consistency chain ends at size ${lastLink.treeSize2} but the checkpoint sealed size ${sealedSize}`,
    );
  }

  // Fold the chain to the latest accumulator (self-check target). Each step
  // runs against a size the caller trusts, never one read off the link being
  // folded: the trusted base for the first link, and the size the previous
  // link was just folded TO for every link after it.
  let accumulator = baseAccumulator;
  let sizeFrom = baseSize;
  for (const p of links) {
    accumulator = await computeCheckpointAccumulator(p, accumulator, sizeFrom);
    sizeFrom = p.treeSize2;
  }
  const aLatest = accumulator;

  // Cross-check the fold against the checkpoint we are borrowing from (F1): the
  // folded accumulator must have the structural peak count for the sealed size
  // AND match the number of pre-signed peak receipts the checkpoint carries.
  // (The cryptographic peak↔signature tie is enforced by downstream verify;
  // freshen holds no key.)
  const structuralPeaks = peakMMRIndexes(sealedSize - 1n).length;
  if (aLatest.length !== structuralPeaks) {
    throw new Error(
      `folded accumulator has ${aLatest.length} peaks; sealed size ${sealedSize} requires ${structuralPeaks}`,
    );
  }
  if (!latest.peakReceipts) {
    throw new Error(
      "latest checkpoint carries no pre-signed peak receipts (label -65931)",
    );
  }
  if (latest.peakReceipts.length !== aLatest.length) {
    throw new Error(
      `checkpoint carries ${latest.peakReceipts.length} peak receipts but the folded accumulator has ${aLatest.length} peaks — chain does not match this checkpoint`,
    );
  }

  // Assemble the leaf's inclusion path at the latest size from index-addressed
  // node values: the old receipt path (leaf → old peak, a prefix by MMR
  // prefix-composability) + the consistency proofs (the climb extension).
  const fullIndices = inclusionProofPath(sealedSize - 1n, leafMmrIndex);
  if (fullIndices.length < oldPath.length) {
    throw new Error(
      "receipt path is longer than the latest inclusion path — stale/forged receipt",
    );
  }
  const store = new Map<bigint, Uint8Array>();
  for (let k = 0; k < oldPath.length; k++) {
    store.set(fullIndices[k]!, oldPath[k]!);
  }
  for (const link of links) {
    // A base-0 link (treeSize1 === 0) has no from-peaks to climb — a 0→N
    // consistency proof carries `paths: []` (the whole accumulator is its
    // right-peaks). Skip it: it contributes no store nodes, and calling
    // `peakMMRIndexes(-1n)` would throw (`posHeight(0)`, FOR-414). A genesis-
    // rooted `.sth` chain always starts with such a link.
    if (link.treeSize1 === 0n) continue;
    const fromPeaks = peakMMRIndexes(link.treeSize1 - 1n);
    fromPeaks.forEach((peakIndex, j) => {
      const climb = link.paths[j];
      if (climb === undefined) return;
      const climbIndices = inclusionProofPath(link.treeSize2 - 1n, peakIndex);
      climbIndices.forEach((ix, e) => {
        const v = climb[e];
        if (v !== undefined) store.set(ix, v);
      });
    });
  }
  const freshPath = fullIndices.map((ix) => {
    const v = store.get(ix);
    if (v === undefined) {
      throw new Error(
        `checkpoint chain does not cover the extension node at ${ix} — supply the full chain from the receipt's era`,
      );
    }
    return v;
  });

  // Self-check: the fresh path must recompute the covering peak of the latest
  // accumulator. Fails closed rather than emitting a bad receipt.
  const hasher = new SubtleHasher();
  const root = await calculateRoot(
    hasher,
    input.leafValue,
    { path: freshPath, mmrIndex: leafMmrIndex },
    leafMmrIndex,
  );
  const peakIdx = peakIndexForLeafProof(sealedSize, freshPath.length);
  if (peakIdx >= aLatest.length || !bytesEqual(root, aLatest[peakIdx]!)) {
    throw new Error(
      "freshened path does not recompute the latest accumulator peak — chain/leaf mismatch",
    );
  }

  const receipt = assembleReceiptFromProof(latest, leafMmrIndex, freshPath);
  return { receipt, sealedSize };
}
