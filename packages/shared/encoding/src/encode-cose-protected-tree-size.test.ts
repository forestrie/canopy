/**
 * `treeSize2` (ADR-0066 D3 as amended 2026-09-20; plan-2609-10 §4.2)
 * protected-header label: canonical byte-exact encoding, cross-checked
 * against the INDEPENDENT `cbor` reference library, plus validation and
 * round-trip via {@link readProtectedTreeSize2}.
 *
 * The sealer's canonical header bytes are those go-merklelog pins in
 * massifs/checkpointsign_test.go (`TestSignCheckpointReceiptProtectedHeaderExactBytes`)
 * and univocity #43 pins in test/shared/ConsistencyHeader.sol; the reader
 * is pinned to them here so the three verifiers read the same size.
 */
import cbor from "cbor";
import { describe, expect, it } from "vitest";
import { decodeCborDeterministic } from "./decode-cbor-deterministic.js";
import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";
import { readProtectedTreeSize2 } from "./cose-protected-tree-size.js";
import { COSE_LABEL_TREE_SIZE_2 } from "./cose-labels.js";
import { encodeCoseProtectedMapBytes } from "./encode-cose-protected.js";

const hex = (u8: Uint8Array) => Buffer.from(u8).toString("hex");
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

/** Canonical ES256 sealer headers `{1: -7, 395: 3, -65933: size}` recorded by
 * go-merklelog main (4b1b789) and univocity #43. */
const SEALER_HEADER_SIZE_1 = "a3012619018b033a0001018c01";
const SEALER_HEADER_SIZE_8 = "a3012619018b033a0001018c08";

describe("encodeCoseProtectedMapBytes with treeSize2", () => {
  const kid = new Uint8Array([0x01, 0x02]);

  it("rejects a negative or non-integer tree size", () => {
    expect(() =>
      encodeCoseProtectedMapBytes(kid, { treeSize2: -10n }),
    ).toThrow();
    expect(() => encodeCoseProtectedMapBytes(kid, { treeSize2: -1 })).toThrow();
    expect(() =>
      encodeCoseProtectedMapBytes(kid, { treeSize2: 1.5 }),
    ).toThrow();
  });

  it("rejects a tree size above uint64 range", () => {
    expect(() =>
      encodeCoseProtectedMapBytes(kid, { treeSize2: 1n << 64n }),
    ).toThrow();
  });

  it("pins the exact hex of {1: -7, 4: <kid 0x0102>, -65933: 10}", () => {
    const got = encodeCoseProtectedMapBytes(kid, { alg: -7, treeSize2: 10 });
    // a3            map(3)
    //   01 26       1: -7
    //   04 42 0102  4: h'0102'
    //   3a 0001018c -65933 (5-byte negative int)
    //   0a          10
    expect(hex(got)).toBe("a30126044201023a0001018c0a");
    const ref = cbor.decodeFirstSync(Buffer.from(got)) as Map<number, unknown>;
    expect(ref.get(1)).toBe(-7);
    expect(ref.get(COSE_LABEL_TREE_SIZE_2)).toBe(10);
    expect(readProtectedTreeSize2(got)).toBe(10n);
  });

  it("pins the exact hex for a tree size above 2^32 (8-byte uint, 0x1b)", () => {
    const treeSize2 = 4294967297n; // 2^32 + 1
    const got = encodeCoseProtectedMapBytes(kid, { alg: -7, treeSize2 });
    expect(hex(got)).toBe("a30126044201023a0001018c1b0000000100000001");
    const ref = cbor.decodeFirstSync(Buffer.from(got)) as Map<number, unknown>;
    expect(BigInt(ref.get(COSE_LABEL_TREE_SIZE_2) as number | bigint)).toBe(
      treeSize2,
    );
    expect(readProtectedTreeSize2(got)).toBe(treeSize2);
  });

  it("accepts a plain number as well as a bigint", () => {
    const a = encodeCoseProtectedMapBytes(kid, { treeSize2: 0 });
    const b = encodeCoseProtectedMapBytes(kid, { treeSize2: 0n });
    expect(hex(a)).toBe(hex(b));
    expect(readProtectedTreeSize2(a)).toBe(0n);
  });

  it("omitting treeSize2 stays byte-identical to prior behaviour", () => {
    const before = encodeCoseProtectedMapBytes(kid, { alg: -7 });
    const after = encodeCoseProtectedMapBytes(kid, {
      alg: -7,
      treeSize2: undefined,
    });
    expect(hex(after)).toBe(hex(before));
    expect(readProtectedTreeSize2(after)).toBeNull();
  });
});

describe("readProtectedTreeSize2", () => {
  it("reads the sealer's canonical header bytes (go-merklelog / univocity KAT)", () => {
    expect(readProtectedTreeSize2(fromHex(SEALER_HEADER_SIZE_1))).toBe(1n);
    expect(readProtectedTreeSize2(fromHex(SEALER_HEADER_SIZE_8))).toBe(8n);
  });

  it("the deterministic encoder reproduces the sealer header byte for byte", () => {
    const got = encodeCborDeterministic(
      new Map<number, number>([
        [1, -7],
        [395, 3],
        [COSE_LABEL_TREE_SIZE_2, 8],
      ]),
    ) as Uint8Array;
    expect(hex(got)).toBe(SEALER_HEADER_SIZE_8);
  });

  it("returns null when the label is absent", () => {
    const bytes = encodeCoseProtectedMapBytes(new Uint8Array([1]), { alg: -7 });
    expect(readProtectedTreeSize2(bytes)).toBeNull();
  });

  it("rejects a negative integer under the label", () => {
    // {1: -7, 395: 3, -65933: -8}
    expect(() =>
      readProtectedTreeSize2(fromHex("a3012619018b033a0001018c27")),
    ).toThrow(/not an unsigned integer/);
  });

  it("rejects a byte string under the label", () => {
    // {1: -7, 395: 3, -65933: h'08'}
    expect(() =>
      readProtectedTreeSize2(fromHex("a3012619018b033a0001018c4108")),
    ).toThrow(/not an unsigned integer/);
  });

  it("rejects a header that is not a CBOR map", () => {
    expect(() => readProtectedTreeSize2(decodeArray())).toThrow(
      /not a CBOR map/,
    );
  });
});

function decodeArray(): Uint8Array {
  // [1, 2]
  const bytes = fromHex("820102");
  expect(Array.isArray(decodeCborDeterministic(bytes))).toBe(true);
  return bytes;
}
