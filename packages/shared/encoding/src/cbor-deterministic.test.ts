/**
 * Correctness gate for the @forestrie/encoding CBOR codec: cross-check the
 * encoder and decoder against the INDEPENDENT `cbor` reference library (not
 * cbor-x) over a corpus, plus round-trips and §4.2/M-L behaviours.
 * status-2607-03-remove-cbor-x-for-scitt-cose-canonicity.
 */
import cbor from "cbor";
import { describe, expect, it } from "vitest";
import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";
import {
  CborTag,
  decodeCborDeterministic,
} from "./decode-cbor-deterministic.js";

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

/** Structural deep-equal that treats our Map output and cbor's object/Map alike. */
function normalize(v: unknown): unknown {
  if (v instanceof Uint8Array || Buffer.isBuffer(v))
    return hex(new Uint8Array(v as Uint8Array));
  if (Array.isArray(v)) return v.map(normalize);
  if (v instanceof Map) {
    const o: Record<string, unknown> = {};
    for (const [k, val] of v) o[String(k)] = normalize(val);
    return { __map: o };
  }
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) o[k] = normalize(val);
    return { __map: o };
  }
  if (typeof v === "bigint") return `bi:${v}`;
  return v;
}

const CORPUS: unknown[] = [
  0,
  23,
  24,
  255,
  256,
  65535,
  65536,
  1000000,
  Number.MAX_SAFE_INTEGER,
  -1,
  -24,
  -256,
  -65931,
  true,
  false,
  null,
  "application/forestrie.delegation+cbor",
  new Uint8Array([]),
  new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  new Uint8Array(64).fill(0x11),
  [1, 2, 3],
  [
    new Uint8Array([1]),
    new Map([[4, new Uint8Array([9])]]),
    null,
    new Uint8Array([2]),
  ],
  new Map<number, unknown>([
    [1, -7],
    [3, "ct"],
    [4, new Uint8Array([0xaa])],
  ]),
  new Map<number, unknown>([
    [-2, new Uint8Array([1, 2])],
    [
      396,
      new Map<number, unknown>([
        [
          -1,
          [
            new Map<number, unknown>([
              [1, 0],
              [2, [new Uint8Array(32).fill(3)]],
            ]),
          ],
        ],
      ]),
    ],
  ]),
  { type: "about:blank", title: "x", status: 404 },
];

describe("@forestrie/encoding CBOR codec vs reference `cbor`", () => {
  it.each(CORPUS.map((v, i): [number, unknown] => [i, v]))(
    "encode #%i decodes tag-free under reference cbor",
    (_i, value) => {
      const bytes = encodeCborDeterministic(value);
      expect(hex(bytes)).not.toContain("d840");
      expect(hex(bytes)).not.toContain("d90103");
      const ref = cbor.decodeFirstSync(Buffer.from(bytes));
      assertNoTags(ref);
      expect(normalize(ref)).toEqual(normalize(value));
    },
  );

  it.each(CORPUS.map((v, i): [number, unknown] => [i, v]))(
    "own encode→decode round-trips #%i",
    (_i, value) => {
      const rt = decodeCborDeterministic(encodeCborDeterministic(value));
      expect(normalize(rt)).toEqual(normalize(value));
    },
  );

  it("decodes reference-`cbor`-canonical bytes identically", () => {
    // Independent canonical encoder → our decoder. Use Buffer (not Uint8Array)
    // so `cbor` emits a plain bstr — `cbor`, like cbor-x, tags a Uint8Array.
    const value = new Map<number, unknown>([
      [1, -7],
      [4, Buffer.from([1, 2, 3])],
    ]);
    const refBytes = cbor.encodeCanonical(value);
    const ours = decodeCborDeterministic(new Uint8Array(refBytes));
    expect(ours).toBeInstanceOf(Map);
    expect(hex((ours as Map<number, Uint8Array>).get(4)!)).toBe("010203");
  });

  it("decodes maps to JS Map (not object) so .get(label) works", () => {
    const bytes = encodeCborDeterministic(new Map([[-65931, "peaks"]]));
    const m = decodeCborDeterministic(bytes) as Map<number, unknown>;
    expect(m).toBeInstanceOf(Map);
    expect(m.get(-65931)).toBe("peaks");
  });

  it("round-trips a COSE tag(18) via CborTag / unwrap", () => {
    const inner = encodeCborDeterministic([
      new Uint8Array([1]),
      new Map(),
      null,
      new Uint8Array([2]),
    ]);
    const tagged = new Uint8Array([0xd2, ...inner]); // 0xd2 = tag(18)
    const decoded = decodeCborDeterministic(tagged);
    expect(decoded).toBeInstanceOf(CborTag);
    expect((decoded as CborTag).tag).toBe(18);
  });

  it("shortest-form integers (no 8-byte bignum for small values)", () => {
    expect(hex(encodeCborDeterministic(0))).toBe("00");
    expect(hex(encodeCborDeterministic(0n))).toBe("00");
    expect(hex(encodeCborDeterministic(1000000))).toBe("1a000f4240");
  });

  it("§4.2 map key ordering is bytewise (canonical)", () => {
    const bytes = encodeCborDeterministic(
      new Map([
        [10, 1],
        [2, 2],
        [-1, 3],
        [100, 4],
      ]),
    );
    const m = decodeCborDeterministic(bytes) as Map<number, number>;
    expect([...m.keys()]).toEqual([2, 10, 100, -1]);
  });

  it("rejects duplicate map keys (§4.2 unique-keys)", () => {
    expect(() =>
      encodeCborDeterministic(
        new Map<unknown, unknown>([
          [1, "a"],
          [1n, "b"],
        ]),
      ),
    ).toThrow(/duplicate/);
  });

  it("skips undefined object properties; throws on top-level undefined", () => {
    const bytes = encodeCborDeterministic({ a: 1, b: undefined });
    const m = decodeCborDeterministic(bytes) as Map<string, unknown>;
    expect([...m.keys()]).toEqual(["a"]);
    expect(() => encodeCborDeterministic(undefined)).toThrow();
  });

  it("throws on non-integer numbers and deep nesting / indefinite input", () => {
    expect(() => encodeCborDeterministic(1.5)).toThrow();
    expect(() => decodeCborDeterministic(new Uint8Array([0x9f, 0xff]))).toThrow(
      /indefinite/,
    );
    expect(() => decodeCborDeterministic(new Uint8Array([0x00, 0x00]))).toThrow(
      /trailing/,
    );
  });
});
