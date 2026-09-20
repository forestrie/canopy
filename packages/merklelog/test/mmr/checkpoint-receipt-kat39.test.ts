/**
 * Cross-language checkpoint-receipt KAT (protocol#10, ADR-0066 D9 as
 * narrowed): `consistency_pairs` and `consistency_negatives` rows exercise
 * the size-driven fold {@link consistentRootsForSizes} directly, against
 * proof paths and accumulators the vector supplies (no tree is rebuilt
 * here).
 *
 * Vector file: read via a relative path from encoding's vendored copy
 * (packages/shared/encoding/src/testdata/checkpoint-receipt-kat39.json) —
 * the single copy this repo keeps, per
 * https://github.com/forestrie/protocol/blob/main/vectors/checkpoint-receipt-format.md
 * ("update ... canopy packages/shared/encoding/src/testdata/"). This is one
 * of three suites in canopy consuming the same file (the others:
 * packages/shared/encoding and packages/libs/receipt-verify); do not edit
 * the vector, only this test.
 *
 * `base_mismatch` is a chain-verifier concern (the caller's trusted origin
 * vs. a proof's declared tree_size_1), not something the fold itself checks
 * — {@link consistentRootsForSizes} has no `trustedSize` parameter, so that
 * row is asserted structurally (tree_size_1 != trusted_tree_size_1) rather
 * than run through the fold. `right_peak_count_mismatch` is the other
 * fold-adjacent case: the fold itself succeeds (right-peak COUNT is only
 * ever a return value, `expectedRight`, never validated against a supplied
 * list of peaks inside the fold), so that row asserts the fold's returned
 * `expectedRight` disagrees with the vector's `right_peaks_hex.length` — the
 * check a caller (receipt-verify's checkpoint-chain.ts) makes on top.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  consistentRootsForSizes,
  createSyncHasher,
  ConsistencyPathLengthMismatch,
  ConsistencyPeakCountMismatch,
  ConsistencyRootMismatch,
  IncompleteTreeSize,
  SizeMustIncrease,
} from "../../src/index.js";
import type { Hasher } from "../../src/mmr/types.js";

const dir = dirname(fileURLToPath(import.meta.url));

/** Pinned per checkpoint-receipt-format.md / protocol SHA256SUMS. */
const EXPECTED_SHA256 =
  "391d203b99b8dc41226694edee4eab3da3f1aa9bc651d13408d1a21b0986a8b8";

interface ConsistencyPairRow {
  name: string;
  tree_size_1: number;
  tree_size_2: number;
  accumulator_from_hex: string[];
  paths_hex: string[][];
  roots_hex: string[];
  right_peak_count: number;
  right_peaks_hex: string[];
  accumulator_to_hex: string[];
}

interface ConsistencyNegativeRow {
  name: string;
  tree_size_1: number;
  tree_size_2: number;
  accumulator_from_hex: string[];
  paths_hex: string[][];
  right_peaks_hex: string[];
  expect: { result: "reject"; class: string };
  trusted_tree_size_1?: number;
}

interface Kat39File {
  tree: {
    accumulators: Record<string, { peaks_hex: string[] }>;
  };
  consistency_pairs: ConsistencyPairRow[];
  consistency_negatives: ConsistencyNegativeRow[];
}

function loadVector(): { raw: string; data: Kat39File } {
  const raw = readFileSync(
    join(
      dir,
      "..",
      "..",
      "..",
      "shared",
      "encoding",
      "src",
      "testdata",
      "checkpoint-receipt-kat39.json",
    ),
    "utf8",
  );
  return { raw, data: JSON.parse(raw) as Kat39File };
}

const fromHex = (hex: string): Uint8Array =>
  new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

let hasher: Hasher;

beforeAll(async () => {
  hasher = await createSyncHasher();
});

describe("checkpoint-receipt-kat39.json (protocol#10)", () => {
  it("the vendored copy (encoding/src/testdata) matches the pinned SHA-256", () => {
    const { raw } = loadVector();
    expect(createHash("sha256").update(raw).digest("hex")).toBe(
      EXPECTED_SHA256,
    );
  });
});

describe("consistentRootsForSizes vs KAT39 consistency_pairs", () => {
  const { data } = loadVector();

  for (const row of data.consistency_pairs) {
    it(row.name, async () => {
      const { roots, expectedRight } = await consistentRootsForSizes(
        hasher,
        BigInt(row.tree_size_1),
        BigInt(row.tree_size_2),
        row.accumulator_from_hex.map(fromHex),
        row.paths_hex.map((path) => path.map(fromHex)),
      );
      expect(roots.map(toHex)).toEqual(row.roots_hex);
      expect(expectedRight).toBe(row.right_peak_count);
      expect(row.right_peaks_hex.length).toBe(row.right_peak_count);

      const combined = [...roots.map(toHex), ...row.right_peaks_hex];
      expect(combined).toEqual(row.accumulator_to_hex);
      const tabulated =
        data.tree.accumulators[String(row.tree_size_2)]?.peaks_hex;
      expect(
        tabulated,
        `no tree.accumulators entry for size ${row.tree_size_2}`,
      ).toBeDefined();
      expect(combined).toEqual(tabulated);
    });
  }
});

describe("consistentRootsForSizes vs KAT39 consistency_negatives", () => {
  const { data } = loadVector();

  const ERROR_CLASSES: Record<string, new (...args: never[]) => Error> = {
    size_must_increase: SizeMustIncrease,
    incomplete_tree_size: IncompleteTreeSize,
    peak_count_mismatch: ConsistencyPeakCountMismatch,
    path_length_mismatch: ConsistencyPathLengthMismatch,
    root_mismatch: ConsistencyRootMismatch,
  };

  for (const row of data.consistency_negatives) {
    const cls = row.expect.class;

    if (cls === "base_mismatch") {
      it(`${row.name}: base_mismatch is a chain-verifier check, not the fold's`, () => {
        expect(row.trusted_tree_size_1).toBeDefined();
        expect(row.tree_size_1).not.toBe(row.trusted_tree_size_1);
      });
      continue;
    }

    if (cls === "right_peak_count_mismatch") {
      it(`${row.name}: the fold succeeds; its right-peak count disagrees with the supplied right_peaks`, async () => {
        const { expectedRight } = await consistentRootsForSizes(
          hasher,
          BigInt(row.tree_size_1),
          BigInt(row.tree_size_2),
          row.accumulator_from_hex.map(fromHex),
          row.paths_hex.map((path) => path.map(fromHex)),
        );
        expect(expectedRight).not.toBe(row.right_peaks_hex.length);
      });
      continue;
    }

    const errorClass = ERROR_CLASSES[cls];
    it(`${row.name}: rejects as ${cls}`, async () => {
      expect(errorClass, `no error class mapped for ${cls}`).toBeDefined();
      await expect(
        consistentRootsForSizes(
          hasher,
          BigInt(row.tree_size_1),
          BigInt(row.tree_size_2),
          row.accumulator_from_hex.map(fromHex),
          row.paths_hex.map((path) => path.map(fromHex)),
        ),
      ).rejects.toBeInstanceOf(errorClass);
    });
  }
});
