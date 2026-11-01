import { describe, expect, it } from "vitest";
import { appendCborUint64 } from "./index.js";
import { decodeCborDeterministic } from "./decode-cbor-deterministic.js";
import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";

const UINT64_MAX = (1n << 64n) - 1n;

function emit(v: bigint | number): string {
  const out: number[] = [];
  appendCborUint64(out, v);
  return Buffer.from(out).toString("hex");
}

describe("appendCborUint64", () => {
  // Shortest-form major type 0, written out by hand (RFC 8949 §3.1).
  it.each([
    [0n, "00"],
    [23n, "17"],
    [24n, "1818"],
    [255n, "18ff"],
    [256n, "190100"],
    [65535n, "19ffff"],
    [65536n, "1a00010000"],
    [0xffffffffn, "1affffffff"],
    [1n << 32n, "1b0000000100000000"],
    [(1n << 53n) + 1n, "1b0020000000000001"],
    [UINT64_MAX, "1bffffffffffffffff"],
  ])("writes %s as %s", (v, expected) => {
    expect(emit(v)).toBe(expected);
    if (v <= BigInt(Number.MAX_SAFE_INTEGER))
      expect(emit(Number(v))).toBe(expected);
  });

  it("agrees with encodeCborDeterministic and round-trips through the decoder", () => {
    for (const v of [0n, 24n, 0x10000n, 1n << 32n, UINT64_MAX]) {
      const hex = emit(v);
      expect(hex).toBe(Buffer.from(encodeCborDeterministic(v)).toString("hex"));
      expect(
        BigInt(
          decodeCborDeterministic(Buffer.from(hex, "hex")) as number | bigint,
        ),
      ).toBe(v);
    }
  });

  it.each([-1, -1n, 1.5, Number.NaN, Infinity, 2 ** 53, UINT64_MAX + 1n])(
    "rejects %s and appends nothing",
    (v) => {
      const out: number[] = [];
      expect(() => appendCborUint64(out, v)).toThrow(/CBOR uint/);
      expect(out).toEqual([]);
    },
  );
});
