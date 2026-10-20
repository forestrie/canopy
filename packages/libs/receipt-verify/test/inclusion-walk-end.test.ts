/**
 * inclusionWalkEndIndex reaches the peak that covers the node, for every
 * node of several MMR sizes, with merklelog's own inclusion paths.
 */
import { describe, expect, it } from "vitest";
import { inclusionProofPath, peakMMRIndexes } from "@forestrie/merklelog";
import { inclusionWalkEndIndex } from "../src/inclusion-walk-end.js";

describe("inclusionWalkEndIndex", () => {
  it.each([1n, 3n, 4n, 7n, 10n, 11n, 25n, 26n])(
    "every node of a size-%s MMR walks to its covering peak",
    (size) => {
      const peaks = peakMMRIndexes(size - 1n);
      for (let i = 0n; i < size; i++) {
        const path = inclusionProofPath(size - 1n, i);
        const covering = peaks.find((p) => p >= i);
        expect(inclusionWalkEndIndex(i, path.length)).toBe(covering);
      }
    },
  );
});
