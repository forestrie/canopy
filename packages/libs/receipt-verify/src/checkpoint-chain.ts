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
 * checkpoint can differ from what the sealer had (the signed origin
 * ADR-0066 D2 first proposed was withdrawn) — a signed size-1 comparison
 * would reject every re-based publish and every multi-link catch-up. One
 * checkpoint may itself relay SEVERAL sealed steps (ADR-0066 D2): the
 * draft carries them under vdp key -2 as
 * `consistency-proofs = [ + consistency-proof ]`, folded here in order,
 * with only the last step's size signed. A checkpoint without the signed
 * size-2 label, or whose signed size-2 disagrees with the last proof it
 * relays, is rejected before any fold is attempted.
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
import {
  COSE_ALG_ES256,
  ProtectedHeaderAlgError,
  isLowS,
  readProtectedAlg,
  readProtectedTreeSize2,
} from "@forestrie/encoding";
import {
  consistentRootsForSizes,
  mmrSizeForLeafCount,
  peakMMRIndexes,
  peaksBitmap,
} from "@forestrie/merklelog";
import { SubtleHasher } from "./subtle-hasher.js";
import { parseCheckpoint } from "./build-receipt-offline.js";
import {
  decodeConsistencyProofsFromUnprotected,
  EmptyConsistencyProofsError,
  type DecodedConsistencyProof,
} from "./decode-checkpoint-consistency-proof.js";

/**
 * The draft-bryce consistency proofs embedded in a v3 checkpoint: one or
 * more, in relay order (`consistency-proofs = [ + consistency-proof ]`,
 * ADR-0066 D2). A checkpoint sealing a single step carries the chain of
 * one; there is no separate single-proof shape.
 *
 * {@link treeSize2} — the LAST proof's — is cross-checked against the
 * checkpoint's SIGNED tree-size-2 (ADR-0066 D1 as amended, D5.5).
 * {@link treeSize1} — the FIRST proof's — is unsigned prover context, not
 * cross-checked here; see {@link verifyCheckpointChain}, which compares it
 * with the trusted origin instead. The sizes between the two are named by
 * no signature: {@link computeCheckpointAccumulator} holds the chain
 * together by requiring each proof to continue the one before it.
 */
export type CheckpointConsistencyProof = {
  /** The relayed proofs, in chain order; never empty. */
  proofs: DecodedConsistencyProof[];
  /** `tree-size-1` of the FIRST proof: the size the chain continues from. */
  treeSize1: bigint;
  /** `tree-size-2` of the LAST proof: the size the chain reaches. */
  treeSize2: bigint;
  /** Signed `tree-size-2` (protected header label -65933); equal to
   * {@link treeSize2} — {@link checkpointConsistencyProof} enforces this. */
  signedTreeSize2: bigint;
};

/**
 * A relayed consistency-proof chain does not join up: a proof's declared
 * `tree-size-1` is not the size the fold has reached — the caller's trusted
 * size for the first proof, the previous proof's `tree-size-2` after that.
 * Reported as `"size_mismatch"` by {@link verifyCheckpointChain}, the same
 * as any other size disagreement, because the sizes it names are unsigned
 * (ADR-0066 D2): nothing distinguishes a relay assembled in the wrong order
 * from one assembled over a different log.
 */
export class ConsistencyChainNotContiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsistencyChainNotContiguousError";
  }
}

export { EmptyConsistencyProofsError };

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
 * The checkpoint's ES256 signature is the malleable high-s twin (`s > n/2`,
 * `n` the P-256 group order): go-merklelog rejects these for checkpoint
 * COSE_Sign1 signatures because the univocity contract's P-256 verifier
 * does, so a receipt that verified here while carrying a high-s signature
 * could be one the chain refuses (FOR-568 rollout item 4). Checked here,
 * before any WebCrypto verify is attempted, so a rejected signature never
 * reaches {@link verifyCheckpointChain}'s `verifySignature` callback. Scoped
 * to the checkpoint receipt path only — this module never touches the WebAuthn
 * (-65800) or session-key-endorsement (-65801) signature paths, which stay
 * governed by their own canonical-form rules.
 */
export class CheckpointHighSSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointHighSSignatureError";
  }
}

/**
 * The checkpoint's protected header carries no integer `alg` (label 1).
 *
 * The univocity contract rejects such a header outright — the structural
 * walk finds the size, and the `alg` requirement in the same call raises
 * `ClaimNotFound(1)` or `UnexpectedMajorType`. Off-chain the header used to
 * read as "no algorithm stated", which both turned OFF the high-s rejection
 * below (gated on the algorithm being ES256) and still yielded a signed size
 * to fold from — so a checkpoint the chain will never anchor verified here
 * under weaker rules than a well-formed one (review finding S-1). Reported
 * as `"proof_malformed"` by {@link verifyCheckpointChain}.
 */
export class CheckpointProtectedHeaderAlgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointProtectedHeaderAlgError";
  }
}

/**
 * Decode the embedded consistency proofs (`vdp` 396 key -2, one or more in
 * relay order) and require the LAST proof's declared `tree-size-2` to equal
 * the checkpoint's SIGNED `tree-size-2` from the protected header (ADR-0066
 * D1 as amended, D2, D5.5, label -65933). The earlier proofs' sizes are not
 * signed: the fold checks them against each other
 * ({@link computeCheckpointAccumulator}). `tree-size-1` is not signed
 * either; see {@link verifyCheckpointChain} for its comparison against the
 * trusted origin.
 *
 * Also rejects a malleable high-s ES256 signature (see
 * {@link CheckpointHighSSignatureError}) before any fold or WebCrypto verify
 * work — a checkpoint signed with any other algorithm (e.g. KS256) is not
 * subject to this check, since it does not go through the P-256 WebCrypto
 * path this guards.
 *
 * @throws {Error} when the unprotected header carries no consistency proof,
 *   a proof is structurally malformed (see
 *   {@link decodeConsistencyProofsFromUnprotected}), or the protected header
 *   carries no signed tree-size-2 label
 * @throws {EmptyConsistencyProofsError} when the consistency-proofs array is
 *   present but empty
 * @throws {CheckpointSignedSizeMismatchError} when the signed tree-size-2
 *   differs from the LAST declared proof's tree-size-2
 * @throws {CheckpointHighSSignatureError} when the checkpoint is ES256-signed
 *   with a high-s (malleable) signature
 * @throws {CheckpointProtectedHeaderAlgError} when the protected header
 *   carries no integer `alg` (label 1)
 */
export function checkpointConsistencyProof(
  checkpointBytes: Uint8Array,
): CheckpointConsistencyProof {
  const { coseSign1, unprotected } = parseCheckpoint(checkpointBytes);
  // Strict: a header with no integer alg is one the contract rejects, and
  // reading it leniently would switch the high-s rejection below off while
  // the signed size was still taken from it (S-1).
  let alg: number;
  try {
    alg = readProtectedAlg(coseSign1[0]);
  } catch (err) {
    if (err instanceof ProtectedHeaderAlgError) {
      throw new CheckpointProtectedHeaderAlgError(
        `checkpoint protected header carries no integer alg (label 1): ${err.message}`,
      );
    }
    throw err;
  }
  const signature = coseSign1[3];
  if (alg === COSE_ALG_ES256 && signature.length === 64 && !isLowS(signature)) {
    throw new CheckpointHighSSignatureError(
      "checkpoint ES256 signature is not low-s canonical (s > n/2); rejected " +
        "to match the univocity contract's P-256 verifier and go-merklelog",
    );
  }
  const proofs = decodeConsistencyProofsFromUnprotected(unprotected);
  if (proofs === null) {
    throw new Error("checkpoint carries no consistency proof (vdp key -2)");
  }
  const last = proofs[proofs.length - 1]!;
  const signedTreeSize2 = readProtectedTreeSize2(coseSign1[0]);
  if (signedTreeSize2 === null) {
    throw new Error(
      "checkpoint protected header carries no signed tree-size-2 (-65933)",
    );
  }
  // The signature covers the size the LAST proof reaches, and only that
  // size: a relay may hold any number of steps before it, none of them
  // signed (ADR-0066 D2).
  if (signedTreeSize2 !== last.treeSize2) {
    throw new CheckpointSignedSizeMismatchError(
      `signed tree-size-2 (-65933) ${signedTreeSize2} != declared consistency-proof tree-size-2 ${last.treeSize2}`,
    );
  }
  return {
    proofs,
    treeSize1: proofs[0]!.treeSize1,
    treeSize2: last.treeSize2,
    signedTreeSize2,
  };
}

/**
 * Fold a checkpoint's relayed consistency proofs, in order, from the
 * CALLER-TRUSTED accumulator at `sizeFrom` to the accumulator at the last
 * proof's `tree-size-2` — the value the checkpoint's signature covers.
 *
 * Each proof is applied by the size-driven {@link consistentRootsForSizes}
 * (ADR-0066 D5), which yields `roots` (the proven prefix); the proof's own
 * right-peaks (the target peaks no path reaches) complete that step's
 * accumulator, and it becomes the next step's input. A checkpoint sealing
 * one step carries the chain of one and runs the same loop once.
 *
 * `sizeFrom` is a parameter, not read off the proofs, because the fold must
 * start from a size the CALLER already trusts (the previous checkpoint's
 * verified `treeSize2`, or the caller's anchor for a first link) — reading
 * it from the relay instead would let an unsigned or substituted proof
 * dictate its own starting point (ADR-0066 D5.4). Every proof after the
 * first is held to the size the previous one reached for the same reason:
 * only the last step's size is signed, so the intermediate sizes are worth
 * no more than their agreement with each other.
 *
 * @throws {ConsistencyChainNotContiguousError} when the first proof's
 *   `treeSize1` is not `sizeFrom`, or a later proof's `treeSize1` is not the
 *   previous proof's `treeSize2`
 * @throws {Error} when a proof supplies a right-peaks count other than
 *   {@link consistentRootsForSizes}'s `expectedRight`
 * @throws {ConsistencyShapeError} (`@forestrie/merklelog`) when a proof does
 *   not have the shape its two sizes imply
 */
export async function computeCheckpointAccumulator(
  proof: CheckpointConsistencyProof,
  accumulatorFrom: Uint8Array[],
  sizeFrom: bigint,
): Promise<Uint8Array[]> {
  const hasher = new SubtleHasher();
  let accumulator = accumulatorFrom;
  let size = sizeFrom;
  for (let i = 0; i < proof.proofs.length; i++) {
    const step = proof.proofs[i]!;
    if (step.treeSize1 !== size) {
      throw new ConsistencyChainNotContiguousError(
        i === 0
          ? `consistency proof base tree-size-1 ${step.treeSize1} does not match the trusted size ${size}`
          : `consistency-proofs entry ${i} declares tree-size-1 ${step.treeSize1}; the previous proof reached ${size}`,
      );
    }
    const { roots, expectedRight } = await consistentRootsForSizes(
      hasher,
      size,
      step.treeSize2,
      accumulator,
      step.paths,
    );
    if (step.rightPeaks.length !== expectedRight) {
      throw new Error(
        `checkpoint supplies ${step.rightPeaks.length} right-peaks; size ${step.treeSize2} requires ${expectedRight}`,
      );
    }
    accumulator = [...roots, ...step.rightPeaks];
    size = step.treeSize2;
  }
  return accumulator;
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
        /**
         * The checkpoint's ES256 signature is the malleable high-s twin (see
         * {@link CheckpointHighSSignatureError}) — rejected before any
         * WebCrypto verify, so it is distinct from `"signature"` (a
         * canonical-form low-s signature that did not verify).
         */
        | "signature_malleable"
        | "proof_malformed"
        /**
         * Two sizes that must be equal are not. Either a checkpoint's SIGNED
         * `tree-size-2` disagrees with its declared consistency-proof
         * `tree-size-2` (ADR-0066 D1 as amended, D5.5), or a link's declared
         * `tree-size-1` disagrees with the size the fold starts from — the
         * caller's `trustedBase.size` (0 with no `trustedBase`) for the
         * first link, the previous link's `tree-size-2` after that — or a
         * relayed proof WITHIN a checkpoint disagrees with the size the
         * proof before it reached ({@link
         * ConsistencyChainNotContiguousError}). `detail` names both sizes.
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
 *   `size` a complete MMR size, its `accumulator` holding one peak per peak
 *   of that size, and every one of those peaks a 32-byte node value.
 *   `peaksBitmap` rounds an incomplete size DOWN to the largest MMR below
 *   it, so without the completeness check a size of 5 folds the 4 -> N shape
 *   while every link reports a base of 5 — a node count no MMR has; and
 *   without the byte-length check an origin peak of any length is copied
 *   through the empty-path branch into the detached payload. All three are
 *   `proof_malformed`.
 * - The first link's declared `tree-size-1` must equal that trusted
 *   starting size, and every subsequent link's must equal the previous
 *   link's sealed `tree-size-2`; either disagreement is `size_mismatch`.
 *   `tree-size-1` itself is never compared with a signed value (the signed
 *   origin ADR-0066 D2 first proposed was withdrawn): only this
 *   trusted-origin comparison applies. Because it is
 *   unsigned, the reason it produces carries no more meaning than the size
 *   disagreement itself (ADR-0066 D6: no pre-FOR-410 state is supported, so
 *   there is no drift condition to fall back from).
 * - A checkpoint may relay SEVERAL consistency proofs under one signature
 *   (ADR-0066 D2; draft `consistency-proofs = [ + consistency-proof ]`).
 *   Its SIGNED `tree-size-2` (ADR-0066 D1 as amended) must equal the LAST
 *   proof's declared `tree-size-2` ({@link checkpointConsistencyProof}),
 *   and each relayed proof must continue the one before it
 *   ({@link computeCheckpointAccumulator}); either disagreement is
 *   `size_mismatch`. A checkpoint sealing one step is the relay of one and
 *   takes the same path.
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
    // …and every peak must be a 32-byte node value, the check arbor's
    // producer applies to both path elements and right-peaks (`toNode32`).
    // The count alone does not reach it: on the empty-path branch an origin
    // peak is copied into the result verbatim, so a 0/31/33/64-byte peak
    // reaches `accumulatorPayload` and shortens or lengthens the detached
    // payload, with only the signature left to reject it (review finding
    // I2, canopy C6).
    for (let i = 0; i < trustedBase.accumulator.length; i++) {
      const peak = trustedBase.accumulator[i] as unknown;
      if (!(peak instanceof Uint8Array) || peak.length !== 32) {
        return {
          ok: false,
          reason: "proof_malformed",
          at: 0,
          detail: `trusted base accumulator peak ${i} is not a 32-byte node value (${describePeak(peak)})`,
          links,
        };
      }
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
      const reason =
        err instanceof CheckpointSignedSizeMismatchError
          ? "size_mismatch"
          : err instanceof CheckpointHighSSignatureError
            ? "signature_malleable"
            : "proof_malformed";
      return {
        ok: false,
        reason,
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
      // A relay that does not join up is a size disagreement like any
      // other: every size it names but the last is unsigned, so the reason
      // can say no more than that two sizes differ.
      return {
        ok: false,
        reason:
          err instanceof ConsistencyChainNotContiguousError
            ? "size_mismatch"
            : "proof_malformed",
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

/** Name what was found where a 32-byte accumulator peak was required. */
function describePeak(peak: unknown): string {
  if (peak instanceof Uint8Array) return `${peak.length} bytes`;
  if (peak === null) return "null";
  if (Array.isArray(peak)) return "an array";
  return typeof peak;
}
