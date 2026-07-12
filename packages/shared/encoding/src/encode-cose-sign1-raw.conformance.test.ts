/**
 * Conformance guard: COSE Sign1 bytes must decode as strict, tag-free CBOR under
 * an INDEPENDENT reference decoder (`cbor`, not cbor-x), proving canonicity
 * non-circularly. Regression guard for
 * status-2607-03-remove-cbor-x-for-scitt-cose-canonicity: cbor-x's default
 * `encode` tags every Uint8Array with tag 64 and every Map with tag 259, which
 * strict COSE/SCITT decoders reject.
 */
import cbor from "cbor";
import { describe, expect, it } from "vitest";
import { encodeCoseSign1Raw } from "./encode-cose-sign1-raw.js";
import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";

function toHex(u8: Uint8Array): string {
  return Buffer.from(u8).toString("hex");
}

/** Recursively assert the decoded structure contains no CBOR tags. */
function assertNoTags(value: unknown): void {
  if (value instanceof cbor.Tagged) {
    throw new Error(`unexpected CBOR tag ${value.tag}`);
  }
  if (Array.isArray(value)) {
    for (const v of value) assertNoTags(v);
  } else if (value instanceof Map) {
    for (const [k, v] of value) {
      assertNoTags(k);
      assertNoTags(v);
    }
  }
}

describe("encodeCoseSign1Raw — strict tag-free COSE (reference `cbor` decoder)", () => {
  const protectedBstr = new Uint8Array([0xa1, 0x01, 0x26]); // {1:-7}
  const kid = new Uint8Array([0xaa, 0xbb]);
  const payload = new Uint8Array([0xde, 0xad]);
  const sig = new Uint8Array(64).fill(0x11);

  it("emits a plain untagged four-tuple decodable by an independent CBOR library", () => {
    const bytes = encodeCoseSign1Raw(
      protectedBstr,
      new Map<number, unknown>([[4, kid]]),
      payload,
      sig,
    );
    const decoded = cbor.decodeFirstSync(Buffer.from(bytes)) as unknown[];
    assertNoTags(decoded);
    expect(Array.isArray(decoded)).toBe(true);
    expect(decoded).toHaveLength(4);
    expect(Buffer.isBuffer(decoded[0])).toBe(true);
    expect(decoded[1]).toBeInstanceOf(Map);
    expect(toHex((decoded[1] as Map<number, Uint8Array>).get(4)!)).toBe("aabb");
    expect(toHex(decoded[2] as Uint8Array)).toBe("dead");
    expect((decoded[3] as Uint8Array).length).toBe(64);
  });

  it("contains no cbor-x extension tags (64 typed-array, 259 map)", () => {
    const bytes = encodeCoseSign1Raw(
      protectedBstr,
      new Map<number, unknown>([[4, kid]]),
      payload,
      sig,
    );
    const hex = toHex(bytes);
    expect(hex).not.toContain("d840"); // tag(64)
    expect(hex).not.toContain("d90103"); // tag(259)
  });

  it("matches the hand-computed golden vector", () => {
    const bytes = encodeCoseSign1Raw(
      protectedBstr,
      new Map<number, unknown>([[4, kid]]),
      payload,
      sig,
    );
    // 84            array(4)
    //   43 a10126   bstr(3) protected {1:-7}
    //   a1 04 42 aabb  map(1) {4: bstr(2) aabb}
    //   42 dead     bstr(2) payload
    //   5840 11*64   bstr(64) signature
    const expected = "8443a10126a10442aabb42dead5840" + "11".repeat(64);
    expect(toHex(bytes)).toBe(expected);
  });

  it("encodes an empty unprotected header as map(0) (0xa0)", () => {
    const bytes = encodeCoseSign1Raw(
      protectedBstr,
      new Map<number, unknown>(),
      payload,
      sig,
    );
    // 84 43a10126 a0 42dead 5840...
    expect(toHex(bytes)).toBe("8443a10126a042dead5840" + "11".repeat(64));
  });

  it("sorts map keys in RFC 8949 §4.2 canonical (bytewise) order", () => {
    // Insertion order 10,2,-1,100 → canonical 2,10,100,-1
    const bytes = encodeCborDeterministic(
      new Map<number, number>([
        [10, 1],
        [2, 2],
        [-1, 3],
        [100, 4],
      ]),
    );
    expect(toHex(bytes)).toBe("a402020a01186404" + "2003");
    const decoded = cbor.decodeFirstSync(Buffer.from(bytes)) as Map<
      number,
      number
    >;
    expect([...decoded.keys()]).toEqual([2, 10, 100, -1]);
  });
});
