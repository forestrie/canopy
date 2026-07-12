/**
 * Unit tests for the deterministic CBOR writer's value coverage, cross-checked
 * against the independent `cbor` reference decoder (not cbor-x). Guards the
 * value types the grant/genesis/receipt/response wire paths now rely on
 * (status-2607-03-remove-cbor-x-for-scitt-cose-canonicity).
 */
import cbor from "cbor";
import { describe, expect, it } from "vitest";
import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";

const hex = (u8: Uint8Array) => Buffer.from(u8).toString("hex");

function assertNoTags(value: unknown): void {
  if (value instanceof cbor.Tagged) throw new Error(`tag ${value.tag}`);
  if (Array.isArray(value)) value.forEach(assertNoTags);
  else if (value instanceof Map)
    for (const [k, v] of value) {
      assertNoTags(k);
      assertNoTags(v);
    }
}

describe("encodeCborDeterministic value coverage", () => {
  it("encodes integers shortest-form", () => {
    expect(hex(encodeCborDeterministic(0))).toBe("00");
    expect(hex(encodeCborDeterministic(23))).toBe("17");
    expect(hex(encodeCborDeterministic(24))).toBe("1818");
    expect(hex(encodeCborDeterministic(-1))).toBe("20");
    expect(hex(encodeCborDeterministic(1000000))).toBe("1a000f4240");
    expect(hex(encodeCborDeterministic(255n))).toBe("18ff");
  });

  it("encodes bool and null as major-7 simples", () => {
    expect(hex(encodeCborDeterministic(true))).toBe("f5");
    expect(hex(encodeCborDeterministic(false))).toBe("f4");
    expect(hex(encodeCborDeterministic(null))).toBe("f6");
  });

  it("encodes Uint8Array and ArrayBuffer identically (plain bstr, no tag)", () => {
    const u8 = new Uint8Array([0xde, 0xad]);
    expect(hex(encodeCborDeterministic(u8))).toBe("42dead");
    expect(hex(encodeCborDeterministic(u8.buffer))).toBe("42dead");
  });

  it("encodes a 1-key object as shortest map (a1, not cbor-x b90001)", () => {
    const bytes = encodeCborDeterministic({ acked: 5 });
    expect(hex(bytes)).toBe("a16561636b656405");
    // `cbor` decodes tstr-keyed maps to plain objects by default.
    expect(cbor.decodeFirstSync(Buffer.from(bytes))).toEqual({ acked: 5 });
  });

  it("skips undefined object properties", () => {
    // { type, title } — detail undefined is omitted → map(2)
    const bytes = encodeCborDeterministic({
      type: "about:blank",
      title: "x",
      detail: undefined,
    });
    const decoded = cbor.decodeFirstSync(Buffer.from(bytes)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(decoded).sort()).toEqual(["title", "type"]);
  });

  it("encodes nested arrays/maps/ArrayBuffer tag-free (pull-response shape)", () => {
    const value = [
      1,
      123456789012345n,
      [[new Uint8Array([1, 2]).buffer, 0n, 1n, [[new Uint8Array([9]).buffer, null]]]],
    ];
    const bytes = encodeCborDeterministic(value);
    expect(hex(bytes)).not.toContain("d840");
    const decoded = cbor.decodeFirstSync(Buffer.from(bytes));
    assertNoTags(decoded);
    expect(Array.isArray(decoded)).toBe(true);
  });

  it("throws on non-integer number and undefined (fail loud, never silent)", () => {
    expect(() => encodeCborDeterministic(1.5)).toThrow();
    expect(() => encodeCborDeterministic(undefined)).toThrow();
  });
});
