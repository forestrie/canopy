/**
 * Freshen a stale receipt (FOR-418 Phase 3, plan-2607-32).
 *
 * A receipt goes stale when log growth buries the peak it commits to. Freshening
 * re-anchors it to the CURRENT sealed state without tiles: extend the leaf's
 * inclusion path from its old peak up to the latest accumulator using the
 * checkpoint chain's consistency proofs (the tile-free source of the climb
 * nodes), then attach that fresh path at header 396 to the LATEST checkpoint's
 * pre-signed peak receipt. The result is a native receipt that verifies with
 * plain `verify --genesis` against the current state — the latest checkpoint
 * carries the genesis-verifiable delegation cert (see plan-2607-32's Phase 3
 * finding: the calldata provider supplies the climb material tile-free, but the
 * signature/cert comes from the latest `.sth`).
 *
 * Trust note: the freshened receipt is defined SOLELY by the latest checkpoint —
 * its label-1000 delegation cert and its pre-signed peak receipt. Owner-rooting
 * is established by the verify step's trust anchor: `verify --genesis` rejects a
 * cert whose delegator is not the genesis owner (a hard failure, not a warning).
 * A rotation of the delegated-TO sealer key is routine and within the owner's
 * authority, so freshen does NOT flag it — there is no signer-change gate (this
 * supersedes the earlier `--allow-new-signer` sketch; see the plan-2607-32 F2
 * note). The old receipt's cert is irrelevant to the emitted artifact.
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
  peakIndexForLeafProof,
  peakMMRIndexes,
} from "@forestrie/merklelog";
import {
  assembleReceiptFromProof,
  parseCheckpoint,
} from "./build-receipt-offline.js";
import {
  computeCheckpointAccumulator,
  type CheckpointConsistencyProof,
} from "./checkpoint-chain.js";
import { parseReceipt } from "./parse-receipt.js";
import { SubtleHasher } from "./subtle-hasher.js";

export type FreshenReceiptInput = {
  /** The stale receipt (COSE Sign1 with a 396 inclusion proof). */
  oldReceiptBytes: Uint8Array;
  /** The leaf's committed value: `SHA-256(idtimestamp ‖ inner)` — the same
   * value `verify` recomputes from the entry (caller derives it). */
  leafValue: Uint8Array;
  /** Consistency-proof chain covering [0 or a trusted seed] → the latest sealed
   * size, in ascending contiguous order (the raw per-checkpoint proofs, with
   * `paths`). The chain's last link must end at the checkpoint's sealed size. */
  consistencyProofs: readonly CheckpointConsistencyProof[];
  /** Trusted accumulator seed for a suffix chain; omit for a chain from base 0.
   * Its peak count must match the first link's tree-size-1. */
  accumulatorFrom?: Uint8Array[];
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
 * Freshen a stale receipt to the latest sealed state. Throws if the chain is
 * not a contiguous cover from the trusted base to the checkpoint's sealed size,
 * if a climb node is missing from the supplied proofs, or if the recomputed
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
  // Base: a base-0 chain starts from an empty accumulator; a suffix chain's
  // trusted seed must have the peak count of its tree-size-1.
  const baseCount = input.accumulatorFrom?.length ?? 0;
  if (firstLink.treeSize1 === 0n) {
    if (baseCount !== 0) {
      throw new Error(
        "base-0 consistency chain must start from an empty accumulator seed",
      );
    }
  } else {
    const wanted = peakMMRIndexes(firstLink.treeSize1 - 1n).length;
    if (baseCount !== wanted) {
      throw new Error(
        `base accumulator has ${baseCount} peaks; first link size ${firstLink.treeSize1} requires ${wanted}`,
      );
    }
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

  // Fold the chain to the latest accumulator (self-check target).
  let accumulator = input.accumulatorFrom ?? [];
  for (const p of links) {
    accumulator = await computeCheckpointAccumulator(p, accumulator);
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
