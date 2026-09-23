/**
 * Decode the draft-bryce consistency proofs carried under a checkpoint's
 * verifiable-proofs UNPROTECTED header (draft-bryce label 396, key -2 =
 * `VDP_CONSISTENCY_PROOF_KEY`).
 *
 * The draft's CDDL is
 * `consistency-proofs = [ + consistency-proof ]`, with each
 * `consistency-proof = bstr .cbor [tree-size-1, tree-size-2, paths,
 * right-peaks]` — one or more proofs, relayed in chain order under a single
 * signature (ADR-0066 D2). Both shapes are accepted under the -2 key:
 *
 * - an ARRAY of one or more proof bstrs — the draft's wire form, and the
 *   only form that can carry a relayed chain;
 * - a BARE proof bstr — the shape every checkpoint sealed before the array
 *   form carries, and the shape the pinned `checkpoint-receipt-kat39.json`
 *   vector's `conventions.receipt` still states. It decodes to the array of
 *   one, so nothing downstream distinguishes it.
 *
 * Single source of truth for this decode, shared by `parseCheckpoint`
 * (build-receipt-offline.ts, lenient: an absent or malformed proof yields a
 * `null` sealed size rather than a throw) and `checkpointConsistencyProof`
 * (checkpoint-chain.ts, full validation: an absent proof or a malformed
 * shape throws, and the SIGNED `tree-size-2` from the protected header —
 * read separately via `readProtectedTreeSize2`, ADR-0066 D1 as amended —
 * must match the `tree-size-2` of the LAST proof decoded here;
 * `tree-size-1` is unsigned prover context and is not cross-checked against
 * a signed value).
 */

import {
  COSE_LABEL_VDP,
  VDP_CONSISTENCY_PROOF_KEY,
  decodeCborDeterministic,
} from "@forestrie/encoding";

/** One declared (unprotected, unsigned) consistency proof of a checkpoint. */
export type DecodedConsistencyProof = {
  treeSize1: bigint;
  treeSize2: bigint;
  /** One inclusion path per tree-size-1 peak, proven at tree-size-2. */
  paths: Uint8Array[][];
  /** New peaks not covered by the proven roots (draft `right-peaks`). */
  rightPeaks: Uint8Array[];
};

/**
 * The verifiable-proofs header carries the consistency-proof key with an
 * EMPTY array. Distinct from an absent proof (no -2 key at all, which
 * decodes to `null`): the key is present and claims to relay a chain, but
 * the chain has no links, so there is nothing to fold and no last proof for
 * the signed `tree-size-2` to equal. `consistency-proofs = [ + ... ]`
 * requires at least one.
 */
export class EmptyConsistencyProofsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyConsistencyProofsError";
  }
}

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

/** Decode one `bstr .cbor [tree-size-1, tree-size-2, paths, right-peaks]`. */
function decodeOneProof(proofBstr: Uint8Array): DecodedConsistencyProof {
  const proof = decodeCborDeterministic(proofBstr);
  // Exactly 4 — the draft's CDDL names a fixed-arity array, and
  // go-merklelog's decoder rejects any other length (F2). A 5th element
  // (e.g. another proof tuple, mistaken for a chain of two) is as malformed
  // as a 3rd missing.
  if (!Array.isArray(proof) || proof.length !== 4) {
    throw new Error(
      `consistency proof must be [tree-size-1, tree-size-2, paths, right-peaks] (4 elements), got ${
        Array.isArray(proof) ? proof.length : typeof proof
      }`,
    );
  }
  const pathsRaw = proof[2];
  if (!Array.isArray(pathsRaw)) {
    throw new Error("consistency paths must be arrays of 32-byte strings");
  }
  // Every path element is an MMR node, so it is 32 bytes — the same rule
  // `asBytesArray` applies to right-peaks. Both reach the same places: the
  // fold hashes them, and the peaks that come out are concatenated by
  // `accumulatorPayload` with no length delimiter, so a node of any other
  // length makes that payload ambiguous. Checking it here also bounds the
  // work an unauthenticated `.sth` can ask for before its signature is
  // consulted.
  for (let i = 0; i < pathsRaw.length; i++) {
    const path = pathsRaw[i] as unknown;
    if (!Array.isArray(path)) {
      throw new Error(
        `consistency path ${i}: expected an array of 32-byte strings`,
      );
    }
    for (let j = 0; j < path.length; j++) {
      const node = path[j] as unknown;
      if (!(node instanceof Uint8Array) || node.length !== 32) {
        throw new Error(
          `consistency path ${i} element ${j}: expected a 32-byte string`,
        );
      }
    }
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

/**
 * Decode proof `at` of a relayed chain, naming its position in the message
 * so a chain of several says which link is malformed. A header carrying a
 * single proof names no position: its message is the one a single-proof
 * checkpoint has always produced.
 */
function decodeProofAt(
  proofBstr: Uint8Array,
  at: number | null,
): DecodedConsistencyProof {
  if (at === null) return decodeOneProof(proofBstr);
  try {
    return decodeOneProof(proofBstr);
  } catch (err) {
    throw new Error(
      `consistency-proofs entry ${at}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Decode the embedded consistency proofs from a checkpoint's UNPROTECTED
 * header map, in the order they are relayed. Returns `null` when the
 * checkpoint carries no verifiable-proofs header (396) or no
 * consistency-proof entry there (key -2) — an ABSENT proof, not a malformed
 * one. A returned array always holds at least one proof.
 *
 * This decode establishes each proof's shape only. Nothing here relates one
 * proof to the next, or to a signed size: the chain has to be checked
 * against state the CALLER trusts, which is `computeCheckpointAccumulator`
 * and `checkpointConsistencyProof` (ADR-0066 D5.4).
 *
 * @throws {EmptyConsistencyProofsError} when the -2 entry is an empty array
 * @throws When a consistency proof IS present but its contents are not the
 *   shape `[tree-size-1, tree-size-2, paths, right-peaks]`, either size is
 *   not an unsigned integer, a proof does not grow the tree
 *   (`tree-size-2 <= tree-size-1`), a path element or a right-peak is not a
 *   32-byte string — or when header 396 is present but is not map-valued,
 *   or its `-2` entry is neither a byte string nor an array of byte strings.
 */
export function decodeConsistencyProofsFromUnprotected(
  unprotected: Map<number, unknown>,
): DecodedConsistencyProof[] | null {
  const vdpRaw = unprotected.get(COSE_LABEL_VDP);
  if (vdpRaw === undefined || vdpRaw === null) return null;
  if (!(vdpRaw instanceof Map)) {
    throw new Error("checkpoint carries no verifiable-proofs header (396)");
  }
  const entry = vdpRaw.get(VDP_CONSISTENCY_PROOF_KEY);
  if (entry === undefined || entry === null) return null;
  if (entry instanceof Uint8Array) {
    // The pre-array shape: a single proof written straight under -2. It is
    // the array of one, and is reported as such.
    return [decodeOneProof(entry)];
  }
  if (!Array.isArray(entry)) {
    throw new Error("checkpoint carries no consistency proof (vdp key -2)");
  }
  if (entry.length === 0) {
    throw new EmptyConsistencyProofsError(
      "consistency-proofs (vdp key -2) is empty; at least one proof is required",
    );
  }
  return entry.map((proofBstr, i) => {
    if (!(proofBstr instanceof Uint8Array)) {
      throw new Error(
        `consistency-proofs entry ${i} is not a byte string (vdp key -2)`,
      );
    }
    return decodeProofAt(proofBstr, entry.length === 1 ? null : i);
  });
}
