/**
 * Decode the draft-bryce consistency proof `[tree-size-1, tree-size-2, paths,
 * right-peaks]` carried under a checkpoint's verifiable-proofs UNPROTECTED
 * header (draft-bryce label 396, key -2 = `VDP_CONSISTENCY_PROOF_KEY`).
 *
 * Single source of truth for this decode, shared by `parseCheckpoint`
 * (build-receipt-offline.ts, lenient: an absent or malformed proof yields a
 * `null` sealed size rather than a throw) and `checkpointConsistencyProof`
 * (checkpoint-chain.ts, full validation: an absent proof or a malformed
 * shape throws, and the SIGNED `tree-size-2` from the protected header —
 * read separately via `readProtectedTreeSize2`, ADR-0066 D1 as amended —
 * must match the `tree-size-2` decoded here; `tree-size-1` is unsigned
 * prover context and is not cross-checked against a signed value).
 */

import {
  COSE_LABEL_VDP,
  VDP_CONSISTENCY_PROOF_KEY,
  decodeCborDeterministic,
} from "@forestrie/encoding";

/** The declared (unprotected, unsigned) consistency proof of a checkpoint. */
export type DecodedConsistencyProof = {
  treeSize1: bigint;
  treeSize2: bigint;
  /** One inclusion path per tree-size-1 peak, proven at tree-size-2. */
  paths: Uint8Array[][];
  /** New peaks not covered by the proven roots (draft `right-peaks`). */
  rightPeaks: Uint8Array[];
};

function asBigint(v: unknown, what: string): bigint {
  // Unsigned only: a negative size flows into peakMMRIndexes /
  // consistentRootsForSizes, which reject or spin on a non-positive
  // argument — a malformed `.sth` must be rejected in bounded time, before
  // any such call (FOR-414).
  if (typeof v === "bigint") {
    if (v < 0n) {
      throw new Error(`${what}: must be an unsigned integer, got ${v}`);
    }
    return v;
  }
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) {
    return BigInt(v);
  }
  throw new Error(`${what}: expected an unsigned integer`);
}

function asBytesArray(v: unknown, what: string): Uint8Array[] {
  if (
    !Array.isArray(v) ||
    v.some((e) => !(e instanceof Uint8Array) || e.length !== 32)
  ) {
    throw new Error(`${what}: expected an array of 32-byte strings`);
  }
  return v as Uint8Array[];
}

/**
 * Decode the embedded consistency proof from a checkpoint's UNPROTECTED
 * header map. Returns `null` when the checkpoint carries no verifiable-proofs
 * header (396) or no consistency-proof bstr there (key -2) — an ABSENT
 * proof, not a malformed one.
 *
 * @throws When a consistency-proof bstr IS present but its contents are not
 *   the shape `[tree-size-1, tree-size-2, paths, right-peaks]`, either size
 *   is not an unsigned integer, the proof does not grow the tree
 *   (`tree-size-2 <= tree-size-1`), the paths are not arrays of byte
 *   strings, or a right-peak is not 32 bytes — or when header 396 is
 *   present but is not map-valued, or its `-2` entry is present but not a
 *   byte string.
 */
export function decodeConsistencyProofFromUnprotected(
  unprotected: Map<number, unknown>,
): DecodedConsistencyProof | null {
  const vdpRaw = unprotected.get(COSE_LABEL_VDP);
  if (vdpRaw === undefined || vdpRaw === null) return null;
  if (!(vdpRaw instanceof Map)) {
    throw new Error("checkpoint carries no verifiable-proofs header (396)");
  }
  const proofBstr = vdpRaw.get(VDP_CONSISTENCY_PROOF_KEY);
  if (proofBstr === undefined || proofBstr === null) return null;
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
  const treeSize1 = asBigint(proof[0], "tree-size-1");
  const treeSize2 = asBigint(proof[1], "tree-size-2");
  // A consistency proof strictly grows the tree; enforce `0 <= ts1 < ts2`
  // (ts1 == 0 is a legitimate base-0 first link). This is the primary guard
  // that keeps sizes non-negative and growing before they reach
  // `consistentRootsForSizes` (FOR-414); the unsigned check in `asBigint`
  // and `SizeMustIncrease` in `@forestrie/merklelog` are defence-in-depth.
  if (treeSize2 <= treeSize1) {
    throw new Error(
      `consistency proof must grow the tree: tree-size-1 ${treeSize1} < tree-size-2 ${treeSize2}`,
    );
  }
  return {
    treeSize1,
    treeSize2,
    paths: pathsRaw as Uint8Array[][],
    rightPeaks: asBytesArray(proof[3], "right-peaks"),
  };
}
