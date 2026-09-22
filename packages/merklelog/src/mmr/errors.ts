/**
 * Typed errors for the size-driven consistency fold
 * (`consistentRootsForSizes`).
 *
 * The names mirror the Solidity `IUnivocityErrors` members raised by the
 * on-chain implementation (`univocity/src/algorithms/consistentRoots.sol`),
 * so a shape rejection reads the same on both sides. Every one of these
 * reports a condition the two sizes fix in advance — the proof does not
 * have the shape MMR(sizeFrom) -> MMR(sizeTo) implies — as distinct from a
 * value mismatch against a trusted accumulator, which callers surface as a
 * plain verification failure.
 *
 * All derive from {@link ConsistencyShapeError} so a caller can map the whole
 * family to "malformed proof" with a single `instanceof`.
 */

/** Base class for every consistency proof-shape rejection. */
export class ConsistencyShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsistencyShapeError";
  }
}

/**
 * The target size is not a complete MMR size.
 *
 * `peaksBitmap` rounds an incomplete size down to the largest complete MMR
 * below it, so for an incomplete `sizeTo` the bitmap describes a different
 * tree than the one named. Accepting it would anchor an accumulator that is
 * no MMR's, and a later verifier would read its entries at the wrong heights.
 */
export class IncompleteTreeSize extends ConsistencyShapeError {
  constructor(readonly size: bigint) {
    super(`size ${size} is not a complete MMR size`);
    this.name = "IncompleteTreeSize";
  }
}

/**
 * The accumulator or the proof list does not have one entry per origin peak.
 * The origin peak count is fixed by `sizeFrom` alone.
 */
export class ConsistencyPeakCountMismatch extends ConsistencyShapeError {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`expected ${expected} entries for the origin peaks, got ${actual}`);
    this.name = "ConsistencyPeakCountMismatch";
  }
}

/**
 * A path does not have the length the two sizes imply: 0 for an origin peak
 * above the split, `split - h` for an origin peak of height `h` below it.
 */
export class ConsistencyPathLengthMismatch extends ConsistencyShapeError {
  constructor(
    readonly index: number,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`path ${index}: expected length ${expected}, got ${actual}`);
    this.name = "ConsistencyPathLengthMismatch";
  }
}

/**
 * Two origin peaks below the split proved different roots. Every origin peak
 * below the split is committed by the single target peak of height `split`,
 * so all of their paths must produce the same value.
 */
export class ConsistencyRootMismatch extends ConsistencyShapeError {
  constructor(readonly index: number) {
    super(`path ${index} proves a different root from the paths before it`);
    this.name = "ConsistencyRootMismatch";
  }
}

/**
 * The target size does not exceed the origin size. Consistency is defined for
 * a growing log; equal or decreasing sizes have no proof shape to check.
 */
export class SizeMustIncrease extends ConsistencyShapeError {
  constructor(
    readonly sizeFrom: bigint,
    readonly sizeTo: bigint,
  ) {
    super(`sizeTo (${sizeTo}) must exceed sizeFrom (${sizeFrom})`);
    this.name = "SizeMustIncrease";
  }
}

/**
 * A size is outside the uint64 domain the MMR profile's sizes live in.
 *
 * Solidity and Go take these sizes as `uint64`, so the domain is part of
 * their signatures; TypeScript's `bigint` has no bound of its own. Without
 * this check a size at or above 2^64 folds here and nowhere else: the
 * position prefix `hash_pospair64` writes is truncated to eight bytes, so
 * the hashes computed above the bound are not the ones the other two
 * implementations would compute, and a size that large is not one a CBOR
 * unsigned integer can carry or the contract can store either.
 */
export class SizeNotUint64 extends ConsistencyShapeError {
  constructor(
    readonly which: "sizeFrom" | "sizeTo",
    readonly size: bigint,
  ) {
    super(`${which} (${size}) is outside the uint64 range [0, 2^64 - 1]`);
    this.name = "SizeNotUint64";
  }
}

/**
 * `paths` is not a dense array of `Uint8Array[]`.
 *
 * A hole (a sparse array), a `null`/`undefined` entry, a path that is not an
 * array, or a path element that is not a `Uint8Array` all survive the peak
 * COUNT check and then surface as a bare `TypeError` out of the fold, which
 * escapes the {@link ConsistencyShapeError} family callers are told to
 * switch on. The shape of the proof material is a proof-shape condition like
 * any other, so it is reported as one.
 */
export class ConsistencyPathMalformed extends ConsistencyShapeError {
  constructor(
    readonly detail: string,
    readonly index?: number,
  ) {
    super(
      index === undefined ? `paths: ${detail}` : `path ${index}: ${detail}`,
    );
    this.name = "ConsistencyPathMalformed";
  }
}
