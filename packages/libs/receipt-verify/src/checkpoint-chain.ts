/**
 * Retained-checkpoint chain verification (FOR-368 Phase 3, plan-2607-29).
 *
 * Post-FOR-410 (ADR-0056) every checkpoint's embedded consistency proof
 * spans its massif's ENTRY BOUNDARY to its seal, so the store's retained
 * `.sth` objects form a contiguous chain `0 → S₁ → S₂ → …`. Folding the
 * chain per the draft ("Chained proofs" / `consistent_roots`) reconstructs
 * each link's tree-size-2 accumulator — which is exactly the detached
 * payload its signature covers (ADR-0046: concat of the accumulator in
 * descending height order). The fold therefore yields, with NO tile access
 * and NO RPC: an authenticated accumulator at every retained seal, and the
 * final state to check a receipt's recomputed peak against.
 *
 * This rung depends only on the public log store — the complement of the
 * `CheckpointPublished` event scan (public chain data only); see the
 * recorded both-paths decision in plan-2607-29.
 *
 * Legacy (pre-FOR-410) chains surface as a contiguity break
 * (`legacy_chain_break`): a permanent per-log condition — fall back to the
 * event scan, tile extension, or a holder cache.
 */
import { decodeCborDeterministic } from "@forestrie/encoding";
import { consistentRoots, peakMMRIndexes } from "@forestrie/merklelog";
import { SubtleHasher } from "./subtle-hasher.js";
import { parseCheckpoint } from "./build-receipt-offline.js";

const VDS_COSE_RECEIPT_PROOFS_TAG = 396;
const VDP_CONSISTENCY_PROOF_KEY = -2;

/** Draft-bryce consistency proof embedded in a v3 checkpoint. */
export type CheckpointConsistencyProof = {
  treeSize1: bigint;
  treeSize2: bigint;
  /** One inclusion path per tree-size-1 peak, proven at tree-size-2. */
  paths: Uint8Array[][];
  /** New peaks not covered by the proven roots (draft `right-peaks`). */
  rightPeaks: Uint8Array[];
};

function asBigint(v: unknown, what: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  throw new Error(`${what}: expected an unsigned integer`);
}

function asBytesArray(v: unknown, what: string): Uint8Array[] {
  if (!Array.isArray(v) || v.some((e) => !(e instanceof Uint8Array))) {
    throw new Error(`${what}: expected an array of byte strings`);
  }
  return v as Uint8Array[];
}

/** Decode the embedded consistency proof (`vdp` 396 key -2). */
export function checkpointConsistencyProof(
  checkpointBytes: Uint8Array,
): CheckpointConsistencyProof {
  const { unprotected } = parseCheckpoint(checkpointBytes);
  const vdpRaw = unprotected.get(VDS_COSE_RECEIPT_PROOFS_TAG);
  if (!(vdpRaw instanceof Map)) {
    throw new Error("checkpoint carries no verifiable-proofs header (396)");
  }
  const proofBstr = (vdpRaw as Map<number, unknown>).get(
    VDP_CONSISTENCY_PROOF_KEY,
  );
  if (!(proofBstr instanceof Uint8Array)) {
    throw new Error("checkpoint carries no consistency proof (vdp key -2)");
  }
  const proof = decodeCborDeterministic(proofBstr);
  if (!Array.isArray(proof) || proof.length < 4) {
    throw new Error(
      "consistency proof must be [tree-size-1, tree-size-2, paths, right-peaks]",
    );
  }
  const pathsRaw = proof[2];
  if (
    !Array.isArray(pathsRaw) ||
    pathsRaw.some(
      (p) => !Array.isArray(p) || p.some((n) => !(n instanceof Uint8Array)),
    )
  ) {
    throw new Error("consistency paths must be arrays of byte strings");
  }
  return {
    treeSize1: asBigint(proof[0], "tree-size-1"),
    treeSize2: asBigint(proof[1], "tree-size-2"),
    paths: pathsRaw as Uint8Array[][],
    rightPeaks: asBytesArray(proof[3], "right-peaks"),
  };
}

/**
 * One fold step: from the trusted accumulator at `proof.treeSize1`,
 * produce the `treeSize2` accumulator (draft: `consistent_roots` output
 * plus the supplied right-peaks). Structural sanity: the result must have
 * exactly the peak count of a size-`treeSize2` MMR.
 */
export async function computeCheckpointAccumulator(
  proof: CheckpointConsistencyProof,
  accumulatorFrom: Uint8Array[],
): Promise<Uint8Array[]> {
  const hasher = new SubtleHasher();
  const proven =
    proof.treeSize1 === 0n
      ? []
      : await consistentRoots(
          hasher,
          proof.treeSize1 - 1n,
          accumulatorFrom,
          proof.paths,
        );
  const accumulator = [...proven, ...proof.rightPeaks];
  const expected = peakMMRIndexes(proof.treeSize2 - 1n).length;
  if (accumulator.length !== expected) {
    throw new Error(
      `computed accumulator has ${accumulator.length} peaks; size ${proof.treeSize2} requires ${expected}`,
    );
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
  accumulator: Uint8Array[];
  signatureOk: boolean;
};

export type CheckpointChainResult =
  | { ok: true; links: CheckpointChainLink[]; accumulator: Uint8Array[] }
  | {
      ok: false;
      reason:
        | "empty_chain"
        | "legacy_chain_break"
        | "signature"
        | "proof_malformed";
      /** Index of the offending checkpoint. */
      at: number;
      detail: string;
      links: CheckpointChainLink[];
    };

/**
 * Verify a retained checkpoint chain (ascending massif order) and fold out
 * the final authenticated accumulator.
 *
 * - The first link must be boundary-based from 0 (a whole-log chain), or
 *   the caller supplies `accumulatorFrom` matching its base (a suffix
 *   chain rooted in an already-trusted accumulator).
 * - Every subsequent link's base must equal the previous link's sealed
 *   size — a mismatch is the legacy (pre-FOR-410) drift signature and is
 *   permanent for that log (`legacy_chain_break`).
 * - Each link's signature is checked over its computed accumulator via
 *   the injected verifier (the caller owns trust resolution — genesis
 *   roots, caller-known keys, or the label-1000 delegation path).
 */
export async function verifyCheckpointChain(opts: {
  checkpoints: Uint8Array[];
  verifySignature: (
    checkpointBytes: Uint8Array,
    detachedPayload: Uint8Array,
  ) => Promise<boolean>;
  /** Trusted base accumulator for a suffix chain (absent: base must be 0). */
  accumulatorFrom?: Uint8Array[];
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
  let accumulator = opts.accumulatorFrom ?? [];
  let expectedBase: bigint | null = null;
  for (let i = 0; i < opts.checkpoints.length; i++) {
    const bytes = opts.checkpoints[i]!;
    let proof: CheckpointConsistencyProof;
    try {
      proof = checkpointConsistencyProof(bytes);
    } catch (err) {
      return {
        ok: false,
        reason: "proof_malformed",
        at: i,
        detail: err instanceof Error ? err.message : String(err),
        links,
      };
    }
    if (expectedBase === null) {
      // First link: base 0 for a whole-log chain, else the caller's
      // trusted accumulator must be FOR this base (peak-count check).
      if (proof.treeSize1 !== 0n) {
        const wanted = peakMMRIndexes(proof.treeSize1 - 1n).length;
        if (opts.accumulatorFrom === undefined) {
          return {
            ok: false,
            reason: "legacy_chain_break",
            at: i,
            detail: `first checkpoint base ${proof.treeSize1} != 0 and no trusted base accumulator was supplied`,
            links,
          };
        }
        if (accumulator.length !== wanted) {
          return {
            ok: false,
            reason: "proof_malformed",
            at: i,
            detail: `trusted base accumulator has ${accumulator.length} peaks; base size ${proof.treeSize1} requires ${wanted}`,
            links,
          };
        }
      }
    } else if (proof.treeSize1 !== expectedBase) {
      return {
        ok: false,
        reason: "legacy_chain_break",
        at: i,
        detail:
          `checkpoint ${i} base ${proof.treeSize1} != previous sealed size ${expectedBase} — ` +
          "pre-FOR-410 drifted chain (permanent for this log); fall back to the event scan, tile extension, or a holder cache",
        links,
      };
    }
    let computed: Uint8Array[];
    try {
      computed = await computeCheckpointAccumulator(proof, accumulator);
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
    links.push({
      treeSize1: proof.treeSize1,
      treeSize2: proof.treeSize2,
      accumulator: computed,
      signatureOk,
    });
    if (!signatureOk) {
      return {
        ok: false,
        reason: "signature",
        at: i,
        detail: `checkpoint ${i} signature does not cover the computed size-${proof.treeSize2} accumulator`,
        links,
      };
    }
    accumulator = computed;
    expectedBase = proof.treeSize2;
  }
  return { ok: true, links, accumulator };
}
