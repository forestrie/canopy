/**
 * `treeSize1` / `treeSize2` (ADR-0066 D3, plan-2609-10 §4.2) protected-header
 * labels: canonical byte-exact encoding, cross-checked against the
 * INDEPENDENT `cbor` reference library, plus validation and round-trip via
 * {@link readProtectedTreeSizes}.
 *
 * The pinned hex below is derived from RFC 8949 §4.2.1 canonical CBOR
 * (shorter key encodings first, then bytewise) — slice 02 (Go) has not yet
 * recorded its own header hex for this shape, so no Go-parity claim is made
 * here; that cross-check lands in slice 06.
 */
import cbor from "cbor";
import { describe, expect, it } from "vitest";
import { decodeCborDeterministic } from "./decode-cbor-deterministic.js";
import { readProtectedTreeSizes } from "./cose-protected-tree-sizes.js";
import {
  COSE_LABEL_TREE_SIZE_1,
  COSE_LABEL_TREE_SIZE_2,
} from "./cose-labels.js";
import { encodeCoseProtectedMapBytes } from "./encode-cose-protected.js";

const hex = (u8: Uint8Array) => Buffer.from(u8).toString("hex");

describe("encodeCoseProtectedMapBytes with treeSize1/treeSize2", () => {
  it("rejects treeSize1 without treeSize2 and vice versa", () => {
    const kid = new Uint8Array([1, 2]);
    expect(() => encodeCoseProtectedMapBytes(kid, { treeSize1: 7 })).toThrow(
      /treeSize1 and treeSize2/,
    );
    expect(() => encodeCoseProtectedMapBytes(kid, { treeSize2: 10 })).toThrow(
      /treeSize1 and treeSize2/,
    );
  });

  it("rejects negative or non-integer tree sizes", () => {
    const kid = new Uint8Array([1, 2]);
    expect(() =>
      encodeCoseProtectedMapBytes(kid, { treeSize1: -1, treeSize2: 10 }),
    ).toThrow();
    expect(() =>
      encodeCoseProtectedMapBytes(kid, { treeSize1: 1.5, treeSize2: 10 }),
    ).toThrow();
    expect(() =>
      encodeCoseProtectedMapBytes(kid, { treeSize1: 7, treeSize2: -10n }),
    ).toThrow();
  });

  it("rejects tree sizes above uint64 range", () => {
    const kid = new Uint8Array([1, 2]);
    const tooBig = (1n << 64n) + 1n;
    expect(() =>
      encodeCoseProtectedMapBytes(kid, { treeSize1: tooBig, treeSize2: 1n }),
    ).toThrow(/uint64/);
  });

  it("pins the exact hex of {1: -7, 4: <kid 0x0102>, -65932: 7, -65933: 10}", () => {
    const kid = new Uint8Array([0x01, 0x02]);
    const got = encodeCoseProtectedMapBytes(kid, {
      alg: -7,
      treeSize1: 7,
      treeSize2: 10,
    });

    // a4 (map 4)
    //   01 26                (1: -7)
    //   04 42 01 02          (4: bstr(2) 01 02)
    //   3a 00 01 01 8b 07    (-65932: 7)
    //   3a 00 01 01 8c 0a    (-65933: 10)
    expect(hex(got)).toBe("a40126044201023a0001018b073a0001018c0a");

    // Cross-check against the independent `cbor` reference decoder.
    const ref = cbor.decodeFirstSync(Buffer.from(got)) as Map<number, unknown>;
    expect(ref).toBeInstanceOf(Map);
    expect(ref.get(1)).toBe(-7);
    expect(hex(new Uint8Array(ref.get(4) as Buffer))).toBe("0102");
    expect(ref.get(-65932)).toBe(7);
    expect(ref.get(-65933)).toBe(10);

    // And our own decoder.
    const ours = decodeCborDeterministic(got) as Map<number, unknown>;
    expect(ours.get(COSE_LABEL_TREE_SIZE_1)).toBe(7);
    expect(ours.get(COSE_LABEL_TREE_SIZE_2)).toBe(10);
  });

  it("pins the exact hex for tree sizes above 2^32 (8-byte uint encoding, 0x1b)", () => {
    const kid = new Uint8Array([0x01, 0x02]);
    const treeSize1 = 4294967296n; // 2^32
    const treeSize2 = 4294967297n; // 2^32 + 1
    const got = encodeCoseProtectedMapBytes(kid, {
      alg: -7,
      treeSize1,
      treeSize2,
    });

    // a4 (map 4)
    //   01 26                                  (1: -7)
    //   04 42 01 02                            (4: bstr(2) 01 02)
    //   3a 00 01 01 8b 1b 00 00 00 01 00 00 00 00  (-65932: 2^32)
    //   3a 00 01 01 8c 1b 00 00 00 01 00 00 00 01  (-65933: 2^32 + 1)
    expect(hex(got)).toBe(
      "a40126044201023a0001018b1b00000001000000003a0001018c1b0000000100000001",
    );

    const ref = cbor.decodeFirstSync(Buffer.from(got)) as Map<number, unknown>;
    expect(BigInt(ref.get(-65932) as number | bigint)).toBe(treeSize1);
    expect(BigInt(ref.get(-65933) as number | bigint)).toBe(treeSize2);

    const readBack = readProtectedTreeSizes(got);
    expect(readBack).toEqual({ treeSize1, treeSize2 });
  });

  it("accepts plain numbers as well as bigints for tree sizes", () => {
    const kid = new Uint8Array([0xaa]);
    const got = encodeCoseProtectedMapBytes(kid, {
      treeSize1: 0,
      treeSize2: 1,
    });
    const decoded = decodeCborDeterministic(got) as Map<number, unknown>;
    expect(decoded.get(COSE_LABEL_TREE_SIZE_1)).toBe(0);
    expect(decoded.get(COSE_LABEL_TREE_SIZE_2)).toBe(1);
  });

  it("omitting both tree sizes stays byte-identical to prior behaviour", () => {
    const kid = new Uint8Array([1, 2, 3]);
    const withoutOption = encodeCoseProtectedMapBytes(kid, { alg: -7 });
    const withUndefined = encodeCoseProtectedMapBytes(kid, {
      alg: -7,
      treeSize1: undefined,
      treeSize2: undefined,
    });
    expect(hex(withUndefined)).toBe(hex(withoutOption));
  });
});

describe("readProtectedTreeSizes", () => {
  it("returns null when neither tree-size label is present", () => {
    const kid = new Uint8Array([1, 2, 3]);
    const protectedBytes = encodeCoseProtectedMapBytes(kid, { alg: -7 });
    expect(readProtectedTreeSizes(protectedBytes)).toBeNull();
  });

  it("returns both sizes when both are present (round-trip via encoder)", () => {
    const kid = new Uint8Array([9, 9]);
    const protectedBytes = encodeCoseProtectedMapBytes(kid, {
      alg: -7,
      treeSize1: 100n,
      treeSize2: 142n,
    });
    expect(readProtectedTreeSizes(protectedBytes)).toEqual({
      treeSize1: 100n,
      treeSize2: 142n,
    });
  });

  it("throws when only tree-size-1 is present", () => {
    const map = new Map<number, unknown>([
      [4, new Uint8Array([1])],
      [COSE_LABEL_TREE_SIZE_1, 7],
    ]);
    const bytes = new Uint8Array(cbor.encodeCanonical(map));
    expect(() => readProtectedTreeSizes(bytes)).toThrow(
      /tree-size-1 and tree-size-2/,
    );
  });

  it("throws when only tree-size-2 is present", () => {
    const map = new Map<number, unknown>([
      [4, new Uint8Array([1])],
      [COSE_LABEL_TREE_SIZE_2, 10],
    ]);
    const bytes = new Uint8Array(cbor.encodeCanonical(map));
    expect(() => readProtectedTreeSizes(bytes)).toThrow(
      /tree-size-1 and tree-size-2/,
    );
  });

  it("throws when a tree-size value is not an unsigned integer", () => {
    const map = new Map<number, unknown>([
      [COSE_LABEL_TREE_SIZE_1, -1],
      [COSE_LABEL_TREE_SIZE_2, 10],
    ]);
    // Encode by hand: our own encoder would refuse a negative uint, and this
    // exercises the decode-side guard, not the encode-side one.
    const bytes = new Uint8Array(cbor.encodeCanonical(map));
    expect(() => readProtectedTreeSizes(bytes)).toThrow(/unsigned integer/);
  });

  it("throws when the protected header is not a CBOR map", () => {
    const bytes = new Uint8Array(cbor.encodeCanonical([1, 2, 3]));
    expect(() => readProtectedTreeSizes(bytes)).toThrow(/not a CBOR map/);
  });
});
