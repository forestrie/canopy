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
 * Trust note: freshening re-anchors to the CURRENT signer. If that signer's
 * delegation differs from the old receipt's, `signerChanged` is set — the caller
 * decides (a rotation could be an upgrade or a downgrade). The path itself is
 * self-checked: `calculateRoot(leaf, freshPath)` must equal the covering peak of
 * the folded latest accumulator, so a bad assembly fails here, never mints a
 * receipt.
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
import {
  parseReceipt,
  requireCoseSign1,
  toHeaderMap,
  unwrapCoseSign1Tag,
} from "./parse-receipt.js";
import { decodeCborDeterministic } from "@forestrie/encoding";
import { SubtleHasher } from "./subtle-hasher.js";

const DELEGATION_CERT_LABEL = 1000;

export type FreshenReceiptInput = {
  /** The stale receipt (COSE Sign1 with a 396 inclusion proof). */
  oldReceiptBytes: Uint8Array;
  /** The leaf's committed value: `SHA-256(idtimestamp ‖ inner)` — the same
   * value `verify` recomputes from the entry (caller derives it). */
  leafValue: Uint8Array;
  /** Consistency-proof chain covering [0 or a trusted seed] → the latest sealed
   * size, in ascending order (the raw per-checkpoint proofs, with `paths`). */
  consistencyProofs: readonly CheckpointConsistencyProof[];
  /** Trusted accumulator seed for a suffix chain; omit for a chain from base 0. */
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
  /** True when the latest checkpoint's delegation cert differs from the old
   * receipt's — the caller gates this behind an explicit opt-in. */
  signerChanged: boolean;
};

function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i]! ^ b[i]!;
  return x === 0;
}

/** The label-1000 delegation cert bytes embedded in a receipt/checkpoint, or null. */
function delegationCertOf(receiptBytes: Uint8Array): Uint8Array | null {
  const sign1 = requireCoseSign1(
    unwrapCoseSign1Tag(decodeCborDeterministic(receiptBytes)),
  );
  const raw = toHeaderMap(sign1[1]).get(DELEGATION_CERT_LABEL);
  return raw instanceof Uint8Array && raw.length > 0 ? raw : null;
}

/**
 * Freshen a stale receipt to the latest sealed state. Throws if the chain does
 * not cover the leaf, if a climb node is missing from the supplied proofs, or if
 * the recomputed peak does not match the folded latest accumulator.
 */
export async function freshenReceipt(
  input: FreshenReceiptInput,
): Promise<FreshenReceiptResult> {
  const { proof } = parseReceipt(input.oldReceiptBytes);
  const leafMmrIndex =
    proof.leafIndex !== undefined ? proof.leafIndex : proof.mmrIndex!;
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

  // Fold the chain to the latest accumulator (self-check target).
  let accumulator = input.accumulatorFrom ?? [];
  for (const p of input.consistencyProofs) {
    accumulator = await computeCheckpointAccumulator(p, accumulator);
  }
  const aLatest = accumulator;

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
  for (const link of input.consistencyProofs) {
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

  const oldCert = delegationCertOf(input.oldReceiptBytes);
  const signerChanged = !bytesEqual(oldCert, latest.delegationCert);

  const receipt = assembleReceiptFromProof(latest, leafMmrIndex, freshPath);
  return { receipt, sealedSize, signerChanged };
}
