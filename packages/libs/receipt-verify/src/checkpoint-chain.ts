/**
 * Retained-checkpoint chain verification (FOR-368 Phase 3, plan-2607-29;
 * FOR-568/ADR-0066 signed size-2, plan-2609-10 §4.4, amended 2026-09-20).
 *
 * Post-FOR-410 (ADR-0056) every checkpoint's embedded consistency proof
 * spans its massif's ENTRY BOUNDARY to its seal, so the store's retained
 * `.sth` objects form a contiguous chain `0 → S₁ → S₂ → …`. Folding the
 * chain via the SIZE-DRIVEN {@link consistentRootsForSizes} (ADR-0066 D5;
 * `@forestrie/merklelog`) reconstructs each link's tree-size-2 accumulator —
 * which is exactly the detached payload its signature covers (ADR-0046:
 * concat of the accumulator in descending height order). The fold therefore
 * yields, with NO tile access and NO RPC: an authenticated accumulator at
 * every retained seal, and the final state to check a receipt's recomputed
 * peak against.
 *
 * Only `tree-size-2` is SIGNED (ADR-0066 D1 as amended: protected header
 * label -65933) — the value folded here is the one the checkpoint's own
 * signature covers, not merely the unprotected consistency proof's declared
 * value, which an unsigned checkpoint could otherwise restate freely (the
 * "keyless first checkpoint" case). `tree-size-1` stays unsigned prover
 * context: the publisher relays several sealed steps and may re-base a step
 * under the head checkpoint's signature, so the declared base of a
 * checkpoint can differ from what the sealer had (D2 chain semantics is
 * withdrawn) — a signed size-1 comparison would reject every re-based
 * publish and every multi-link catch-up. A checkpoint without the signed
 * size-2 label, or whose signed size-2 disagrees with its declared proof,
 * is rejected before any fold is attempted.
 *
 * This rung depends only on the public log store — the complement of the
 * `CheckpointPublished` event scan (public chain data only); see the
 * recorded both-paths decision in plan-2607-29.
 *
 * No pre-FOR-410 state is supported (ADR-0066 D6): the affected logs are
 * re-anchored, so there is no drift condition to signal and no fallback to
 * select. A declared `tree-size-1` that does not continue the state being
 * folded is `size_mismatch` like any other size disagreement — and it has to
 * be, because that value is unsigned: a relaying party can set it without
 * the key, so no reason string chosen from it may mean anything more than
 * "these two sizes differ".
 */
import { readProtectedTreeSize2 } from "@forestrie/encoding";
import {
  consistentRootsForSizes,
  mmrSizeForLeafCount,
  peakMMRIndexes,
  peaksBitmap,
} from "@forestrie/merklelog";
import { SubtleHasher } from "./subtle-hasher.js";
import { parseCheckpoint } from "./build-receipt-offline.js";
import { decodeConsistencyProofFromUnprotected } from "./decode-checkpoint-consistency-proof.js";

/** Draft-bryce consistency proof embedded in a v3 checkpoint. `treeSize2` is
 * cross-checked against the checkpoint's SIGNED tree-size-2 (ADR-0066 D1 as
 * amended); `treeSize1` is unsigned prover context, not cross-checked here —
 * see {@link verifyCheckpointChain}, which compares it with the trusted
 * origin instead. */
export type CheckpointConsistencyProof = {
  treeSize1: bigint;
  treeSize2: bigint;
  /** Signed `tree-size-2` (protected header label -65933); equal to
   * {@link treeSize2} — {@link checkpointConsistencyProof} enforces this. */
  signedTreeSize2: bigint;
  /** One inclusion path per tree-size-1 peak, proven at tree-size-2. */
  paths: Uint8Array[][];
  /** New peaks not covered by the proven roots (draft `right-peaks`). */
  rightPeaks: Uint8Array[];
};

/**
 * The checkpoint's SIGNED `tree-size-2` (protected header, ADR-0066 D1 as
 * amended) differs from the declared `tree-size-2` of its embedded
 * (unprotected) consistency proof. Distinct from a structurally malformed
 * proof: {@link verifyCheckpointChain} reports this as `"size_mismatch"`,
 * not `"proof_malformed"`.
 */
export class CheckpointSignedSizeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointSignedSizeMismatchError";
  }
}

/**
 * Decode the embedded consistency proof (`vdp` 396 key -2) and require its
 * declared `tree-size-2` to equal the checkpoint's SIGNED `tree-size-2` from
 * the protected header (ADR-0066 D1 as amended, D5.5, label -65933).
 * `tree-size-1` is not signed and is not checked here (D2 is withdrawn); see
 * {@link verifyCheckpointChain} for its comparison against the trusted
 * origin.
 *
 * @throws {Error} when the protected header carries no consistency proof,
 *   the proof is structurally malformed (see
 *   {@link decodeConsistencyProofFromUnprotected}), or the protected header
 *   carries no signed tree-size-2 label
 * @throws {CheckpointSignedSizeMismatchError} when the signed tree-size-2
 *   differs from the declared proof's tree-size-2
 */
export function checkpointConsistencyProof(
  checkpointBytes: Uint8Array,
): CheckpointConsistencyProof {
  const { coseSign1, unprotected } = parseCheckpoint(checkpointBytes);
  const declared = decodeConsistencyProofFromUnprotected(unprotected);
  if (declared === null) {
    throw new Error("checkpoint carries no consistency proof (vdp key -2)");
  }
  const signedTreeSize2 = readProtectedTreeSize2(coseSign1[0]);
  if (signedTreeSize2 === null) {
    throw new Error(
      "checkpoint protected header carries no signed tree-size-2 (-65933)",
    );
  }
  if (signedTreeSize2 !== declared.treeSize2) {
    throw new CheckpointSignedSizeMismatchError(
      `signed tree-size-2 (-65933) ${signedTreeSize2} != declared consistency-proof tree-size-2 ${declared.treeSize2}`,
    );
  }
  return {
    treeSize1: declared.treeSize1,
    treeSize2: declared.treeSize2,
    signedTreeSize2,
    paths: declared.paths,
    rightPeaks: declared.rightPeaks,
  };
}

/**
 * One fold step: from the CALLER-TRUSTED accumulator at `sizeFrom`, produce
 * the `proof.treeSize2` accumulator via the size-driven
 * {@link consistentRootsForSizes} (ADR-0066 D5) — `roots` (the proven
 * prefix) followed by the proof's supplied right-peaks (the target peaks no
 * path reaches).
 *
 * `sizeFrom` is a parameter, not read off `proof`, because the fold must run
 * against a size the CALLER already trusts (the previous link's verified
 * `treeSize2`, or the caller's anchor for a first link) — reading it from
 * the proof instead would let an unsigned or substituted proof dictate its
 * own starting point. `proof.treeSize1` must equal it regardless: the two
 * disagreeing means this proof does not continue from the state being
 * folded, not a mere shape defect, so it is checked before any fold work.
 *
 * @throws {Error} when `proof.treeSize1 !== sizeFrom`, or when the proof
 *   supplies a right-peaks count other than
 *   {@link consistentRootsForSizes}'s `expectedRight`
 * @throws {ConsistencyShapeError} (`@forestrie/merklelog`) when the proof
 *   does not have the shape MMR(sizeFrom) -> MMR(proof.treeSize2) implies
 */
export async function computeCheckpointAccumulator(
  proof: CheckpointConsistencyProof,
  accumulatorFrom: Uint8Array[],
  sizeFrom: bigint,
): Promise<Uint8Array[]> {
  if (proof.treeSize1 !== sizeFrom) {
    throw new Error(
      `consistency proof base tree-size-1 ${proof.treeSize1} does not match the trusted size ${sizeFrom}`,
    );
  }
  const hasher = new SubtleHasher();
  const { roots, expectedRight } = await consistentRootsForSizes(
    hasher,
    sizeFrom,
    proof.treeSize2,
    accumulatorFrom,
    proof.paths,
  );
  if (proof.rightPeaks.length !== expectedRight) {
    throw new Error(
      `checkpoint supplies ${proof.rightPeaks.length} right-peaks; size ${proof.treeSize2} requires ${expectedRight}`,
    );
  }
  return [...roots, ...proof.rightPeaks];
}

/** Detached payload the checkpoint signature covers (ADR-0046): the raw
 * concatenation of the accumulator peaks in contract order. */
export function accumulatorPayload(accumulator: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(accumulator.reduce((s, p) => s + p.length, 0));
  let offset = 0;
  for (const p of accumulator) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export type CheckpointChainLink = {
  treeSize1: bigint;
  treeSize2: bigint;
  /** Signed `tree-size-2` (protected header label -65933; ADR-0066 D1 as
   * amended). */
  signedTreeSize2: bigint;
  accumulator: Uint8Array[];
  /** Always `true`: a link is recorded only after its signature verified. */
  signatureOk: boolean;
};

export type CheckpointChainResult =
  | { ok: true; links: CheckpointChainLink[]; accumulator: Uint8Array[] }
  | {
      ok: false;
      reason:
        | "empty_chain"
        | "signature"
        | "proof_malformed"
        /**
         * Two sizes that must be equal are not. Either a checkpoint's SIGNED
         * `tree-size-2` disagrees with its declared consistency-proof
         * `tree-size-2` (ADR-0066 D1 as amended, D5.5), or a link's declared
         * `tree-size-1` disagrees with the size the fold starts from — the
         * caller's `trustedBase.size` (0 with no `trustedBase`) for the
         * first link, the previous link's `tree-size-2` after that.
         * `detail` names both sizes.
         */
        | "size_mismatch";
      /** Index of the offending checkpoint. */
      at: number;
      detail: string;
      links: CheckpointChainLink[];
    };

/**
 * Verify a retained checkpoint chain (ascending massif order) and fold out
 * the final authenticated accumulator.
 *
 * - The first link's trusted starting size is `trustedBase?.size ?? 0n`
 *   (base 0 for a whole-log chain) with `trustedBase?.accumulator ?? []`
 *   as the fold's starting accumulator (a suffix chain rooted in an
 *   already-trusted accumulator supplies both).
 * - A supplied `trustedBase` must describe a state an MMR can be in: its
 *   `size` a complete MMR size, and its `accumulator` holding one peak per
 *   peak of that size. `peaksBitmap` rounds an incomplete size DOWN to the
 *   largest MMR below it, so without the completeness check a size of 5
 *   folds the 4 -> N shape while every link reports a base of 5 — a node
 *   count no MMR has. Both are `proof_malformed`.
 * - The first link's declared `tree-size-1` must equal that trusted
 *   starting size, and every subsequent link's must equal the previous
 *   link's sealed `tree-size-2`; either disagreement is `size_mismatch`.
 *   `tree-size-1` itself is never compared with a signed value (D2 is
 *   withdrawn): only this trusted-origin comparison applies. Because it is
 *   unsigned, the reason it produces carries no more meaning than the size
 *   disagreement itself (ADR-0066 D6: no pre-FOR-410 state is supported, so
 *   there is no drift condition to fall back from).
 * - Each checkpoint's SIGNED `tree-size-2` (ADR-0066 D1 as amended) must
 *   equal its declared consistency-proof `tree-size-2`
 *   ({@link checkpointConsistencyProof}); a disagreement is
 *   `size_mismatch`.
 * - Each link's signature is checked over its computed accumulator via
 *   the injected verifier (the caller owns trust resolution — genesis
 *   roots, caller-known keys, or the label-1000 delegation path). A link
 *   joins `links` only once its signature has verified, so on any failure
 *   `links` is the verified prefix and never holds an accumulator nothing
 *   attested.
 */
export async function verifyCheckpointChain(opts: {
  checkpoints: Uint8Array[];
  verifySignature: (
    checkpointBytes: Uint8Array,
    detachedPayload: Uint8Array,
  ) => Promise<boolean>;
  /** Trusted base for a suffix chain (a whole-log chain has base size 0 and
   * an empty accumulator, which is also the default when this is absent). */
  trustedBase?: { size: bigint; accumulator: Uint8Array[] };
}): Promise<CheckpointChainResult> {
  const links: CheckpointChainLink[] = [];
  if (opts.checkpoints.length === 0) {
    return {
      ok: false,
      reason: "empty_chain",
      at: 0,
      detail: "no checkpoints supplied",
      links,
    };
  }
  const trustedBase = opts.trustedBase;
  if (trustedBase !== undefined) {
    // A size that is not a complete MMR size describes no state: the fold
    // would silently use the largest MMR below it (`peaksBitmap` rounds
    // down) while every link reported the supplied value as its base.
    if (
      trustedBase.size < 0n ||
      mmrSizeForLeafCount(peaksBitmap(trustedBase.size)) !== trustedBase.size
    ) {
      return {
        ok: false,
        reason: "proof_malformed",
        at: 0,
        detail: `trusted base size ${trustedBase.size} is not a complete MMR size`,
        links,
      };
    }
    // …and the accumulator must hold exactly the peaks that size has, which
    // the fold otherwise only compares against the rounded-down count.
    const basePeaks =
      trustedBase.size === 0n
        ? 0
        : peakMMRIndexes(trustedBase.size - 1n).length;
    if (trustedBase.accumulator.length !== basePeaks) {
      return {
        ok: false,
        reason: "proof_malformed",
        at: 0,
        detail: `trusted base accumulator has ${trustedBase.accumulator.length} peaks; size ${trustedBase.size} has ${basePeaks}`,
        links,
      };
    }
  }
  let accumulator = trustedBase?.accumulator ?? [];
  let expectedBase = trustedBase?.size ?? 0n;
  for (let i = 0; i < opts.checkpoints.length; i++) {
    const bytes = opts.checkpoints[i]!;
    let proof: CheckpointConsistencyProof;
    try {
      proof = checkpointConsistencyProof(bytes);
    } catch (err) {
      return {
        ok: false,
        reason:
          err instanceof CheckpointSignedSizeMismatchError
            ? "size_mismatch"
            : "proof_malformed",
        at: i,
        detail: err instanceof Error ? err.message : String(err),
        links,
      };
    }
    if (proof.treeSize1 !== expectedBase) {
      if (i === 0) {
        return {
          ok: false,
          reason: "size_mismatch",
          at: i,
          detail:
            trustedBase === undefined
              ? `first checkpoint declared tree-size-1 ${proof.treeSize1} != whole-log base size ${expectedBase} and no trusted base was supplied`
              : `first checkpoint declared tree-size-1 ${proof.treeSize1} != trusted base size ${expectedBase}`,
          links,
        };
      }
      return {
        ok: false,
        reason: "size_mismatch",
        at: i,
        detail:
          `checkpoint ${i} declared tree-size-1 ${proof.treeSize1} != the previous link's tree-size-2 ${expectedBase} — ` +
          "the declared origin is unsigned, so the chain is treated as not continuous",
        links,
      };
    }
    let computed: Uint8Array[];
    try {
      computed = await computeCheckpointAccumulator(
        proof,
        accumulator,
        expectedBase,
      );
    } catch (err) {
      return {
        ok: false,
        reason: "proof_malformed",
        at: i,
        detail: err instanceof Error ? err.message : String(err),
        links,
      };
    }
    const signatureOk = await opts.verifySignature(
      bytes,
      accumulatorPayload(computed),
    );
    if (!signatureOk) {
      // `links` stays the verified prefix: the computed accumulator of a
      // link whose signature did not verify is attested by nothing, so it
      // is not handed back.
      return {
        ok: false,
        reason: "signature",
        at: i,
        detail: `checkpoint ${i} signature does not cover the computed size-${proof.treeSize2} accumulator`,
        links,
      };
    }
    links.push({
      treeSize1: proof.treeSize1,
      treeSize2: proof.treeSize2,
      signedTreeSize2: proof.signedTreeSize2,
      accumulator: computed,
      signatureOk,
    });
    accumulator = computed;
    expectedBase = proof.treeSize2;
  }
  return { ok: true, links, accumulator };
}
