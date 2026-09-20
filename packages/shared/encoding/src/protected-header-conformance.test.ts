/**
 * Protected-header conformance vectors (ADR-0066 D9, amendment 2, 2026-09-20),
 * one row per header class, driven through {@link readProtectedTreeSize2} —
 * the reader a checkpoint's signed size comes out of.
 *
 * The rule, verbatim from the amendment:
 *
 * > A checkpoint receipt's protected header MUST be deterministically encoded
 * > CBOR (RFC 8949 §4.2.1): arguments in shortest form; definite lengths only;
 * > keys in canonical order (shorter encoding first, then bytewise), which
 * > makes any duplicate keys adjacent; no duplicate keys; no tags. A string
 * > length that exceeds the remaining bytes is rejected. The map MUST consume
 * > the whole header: no trailing bytes, and a map MUST NOT declare fewer
 * > pairs than it carries. Integer keys whose magnitude exceeds int64 are
 * > rejected. A verifier MUST reject a header that is not so encoded, and MUST
 * > NOT read any value from a header whose map does not consume the whole
 * > header. A verifier MUST skip, not reject, a label it does not read whose
 * > value is any well-formed definite-length item, including major type 7:
 * > false, true, null, undefined and the other simple values 0–23, two-byte
 * > simple values 32–255, and half, single and double floats. Malformed forms
 * > are rejected: additional information 28–30, the break code 31, a two-byte
 * > simple value below 32, a float cut off by the end of the header. Tags are
 * > the one exception and stay rejected.
 *
 * {@link HEADER_VECTORS} mirrors the Go table in go-merklelog
 * `massifs/checkpointsign_test.go`
 * (`TestProtectedHeaderTreeSizeRejectsNonCanonicalHeaders`) and is written as a
 * name/hex/expectation table so slice 06 can lift the rows into a
 * cross-language KAT file: `accept` carries the size every conformant verifier
 * must read, `absent` the header with no signed size, `reject` a header no
 * verifier may read a size from.
 *
 * Every canonical sealer header here is `{1: -7, 395: 3, -65933: size}`:
 *   a3            map(3)
 *     01 26       1: -7            (alg ES256)
 *     19 018b 03  395: 3           (vds = CheckpointVDSConsistency)
 *     3a 0001018c 08   -65933: 8   (tree-size-2)
 * Key encodings are 1, 3 and 5 bytes and ascend under both canonical key
 * orders, which is why the estate's headers are unaffected by the divergence
 * pinned at the end of this file.
 */
import { describe, expect, it } from "vitest";
import { readProtectedTreeSize2 } from "./cose-protected-tree-size.js";
import {
  CborFloat,
  CborSimple,
  CborTag,
  decodeCborDeterministic,
  decodeCborDeterministicStrict,
} from "./decode-cbor-deterministic.js";
import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";

const fromHex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const hex = (u8: Uint8Array) => Buffer.from(u8).toString("hex");

/** What a conformant verifier must do with a header class. */
type Expectation =
  | { readonly result: "accept"; readonly treeSize2: bigint }
  | { readonly result: "absent" }
  | { readonly result: "reject"; readonly why: RegExp };

interface HeaderVector {
  /** KAT row name; stable, so slice 06 can match rows across languages. */
  readonly name: string;
  /** The protected header MAP bytes (not the enclosing bstr). */
  readonly hex: string;
  /** Byte breakdown of what makes this row its class. */
  readonly note: string;
  readonly expect: Expectation;
}

const accept = (treeSize2: bigint): Expectation => ({
  result: "accept",
  treeSize2,
});
const reject = (why: RegExp): Expectation => ({ result: "reject", why });

const HEADER_VECTORS: readonly HeaderVector[] = [
  // ---- canonical ---------------------------------------------------------
  {
    name: "canonical/size-8",
    hex: "a3012619018b033a0001018c08",
    note: "the sealer's header, size 8 as a 1-byte uint",
    expect: accept(8n),
  },
  {
    name: "canonical/size-1",
    hex: "a3012619018b033a0001018c01",
    note: "the sealer's header, size 1",
    expect: accept(1n),
  },

  // ---- skip, not reject: major type 7 under a label we do not read -------
  {
    name: "skip/mt7-false",
    hex: "a4012607f419018b033a0001018c08",
    note: "{1: -7, 7: false, 395: 3, -65933: 8}; `07 f4` is skipped",
    expect: accept(8n),
  },
  {
    name: "skip/mt7-null",
    hex: "a4012607f619018b033a0001018c08",
    note: "`07 f6` (null) under the unread label 7",
    expect: accept(8n),
  },
  {
    name: "skip/mt7-simple-40",
    hex: "a4012607f82819018b033a0001018c08",
    note: "`07 f8 28`: two-byte simple value 40, well formed (32–255)",
    expect: accept(8n),
  },
  {
    name: "skip/mt7-half-float-1.0",
    hex: "a4012607f93c0019018b033a0001018c08",
    note: "`07 f9 3c00`: half float 1.0",
    expect: accept(8n),
  },
  {
    name: "skip/mt7-double-float-1.0",
    hex: "a4012607fb3ff000000000000019018b033a0001018c08",
    note: "`07 fb 3ff0000000000000`: double 1.0",
    expect: accept(8n),
  },

  // ---- shortest-form arguments -------------------------------------------
  {
    name: "reject/non-shortest-value-4-byte",
    hex: "a3012619018b033a0001018c1a00000008",
    note: "size 8 written `1a 00000008` (4-byte argument) instead of `08`",
    expect: reject(/shortest form/),
  },
  {
    name: "reject/non-shortest-value-1-byte",
    hex: "a3012619018b033a0001018c1808",
    note: "size 8 written `18 08`: ai=24 arguments must be >= 24",
    expect: reject(/shortest form/),
  },
  {
    name: "reject/non-shortest-key",
    hex: "a301261a0000018b033a0001018c08",
    note: "key 395 written `1a 0000018b` (4-byte) instead of `19 018b`",
    expect: reject(/shortest form/),
  },

  // ---- canonical key order (shorter encoding first, then bytewise) -------
  {
    name: "reject/keys-reversed",
    hex: "a33a0001018c0819018b030126",
    note: "the three pairs in reverse: -65933 (5 bytes) then 395 then 1",
    expect: reject(/out of canonical order/),
  },
  {
    name: "reject/tree-size-before-vds",
    hex: "a301263a0001018c0819018b03",
    note: "-65933 (5-byte key) placed before 395 (3-byte key)",
    expect: reject(/out of canonical order/),
  },
  {
    name: "reject/duplicate-tree-size-label",
    hex: "a4012619018b033a0001018c043a0001018c08",
    note: "-65933 twice, 4 then 8; canonical order makes duplicates adjacent",
    expect: reject(/duplicate map key/),
  },

  // ---- the map must consume the whole header -----------------------------
  {
    name: "reject/trailing-byte",
    hex: "a3012619018b033a0001018c0800",
    note: "a canonical 3-pair map followed by a stray `00`",
    expect: reject(/trailing byte/),
  },
  {
    name: "reject/under-declared-map",
    hex: "a2012619018b033a0001018c08",
    note: "`a2` declares 2 pairs but carries 3; the third is left over, and a verifier must read no value from it",
    expect: reject(/trailing byte/),
  },
  {
    name: "reject/string-length-beyond-header",
    hex: "a20126044a0102",
    note: "{1: -7, 4: bstr} where `4a` claims 10 bytes and only 2 follow",
    expect: reject(/unexpected end of input/),
  },

  // ---- integer keys beyond int64 -----------------------------------------
  {
    name: "reject/uint-key-beyond-int64",
    hex: "a4012619018b033a0001018c081b800000000000000000",
    note: "key `1b 8000000000000000` = 2^63 (9-byte, so last in canonical order), value 0",
    expect: reject(/exceeds int64 magnitude/),
  },
  {
    name: "reject/negative-key-beyond-int64",
    hex: "a4012619018b033a0001018c083b800000000000000000",
    note: "key `3b 8000000000000000` = -2^63 - 1, value 0",
    expect: reject(/exceeds int64 magnitude/),
  },

  // ---- the label itself ---------------------------------------------------
  {
    name: "absent/no-tree-size-label",
    hex: "a2012619018b03",
    note: "{1: -7, 395: 3}: no signed size; the caller reports it missing",
    expect: { result: "absent" },
  },
  {
    name: "reject/tree-size-negative",
    hex: "a3012619018b033a0001018c27",
    note: "-65933: -8 (`27`), a negative integer where a uint is required",
    expect: reject(/not an unsigned integer/),
  },
  {
    name: "reject/tree-size-bstr",
    hex: "a3012619018b033a0001018c4108",
    note: "-65933: h'08'; a byte string is not reinterpreted as 8",
    expect: reject(/not an unsigned integer/),
  },
  {
    name: "reject/tree-size-half-float",
    hex: "a3012619018b033a0001018cf94800",
    note: "-65933: half float 8.0 (`f9 4800`); skippable under an unread label, never a size",
    expect: reject(/not an unsigned integer/),
  },
  {
    name: "reject/tree-size-tagged",
    hex: "a3012619018b033a0001018cc108",
    note: "-65933: tag(1) 8 — tags stay rejected",
    expect: reject(/tag 1 is not allowed/),
  },
  {
    name: "reject/tree-size-bignum",
    hex: "a3012619018b033a0001018cc24108",
    note: "-65933: tag(2) h'08' (bignum 8) — a tag, so rejected",
    expect: reject(/tag 2 is not allowed/),
  },

  // ---- definite lengths only ----------------------------------------------
  {
    name: "reject/indefinite-map",
    hex: "bf012619018b033a0001018c08ff",
    note: "`bf` ... `ff`: the canonical pairs in an indefinite-length map",
    expect: reject(/indefinite/),
  },

  // ---- malformed major type 7 ---------------------------------------------
  {
    name: "reject/mt7-additional-info-28",
    hex: "a3012619018b033a0001018cfc",
    note: "`fc`: major type 7 with ai 28, reserved and not well formed",
    expect: reject(/malformed additional info 28/),
  },
  {
    name: "reject/mt7-break-as-value",
    hex: "a3012619018b033a0001018cff",
    note: "`ff`: the break code standing in for a value",
    expect: reject(/break code/),
  },
  {
    name: "reject/mt7-two-byte-simple-below-32",
    hex: "a3012619018b033a0001018cf81f",
    note: "`f8 1f`: simple value 31 in the two-byte form; 0–31 must use the one-byte form",
    expect: reject(/below 32/),
  },
  {
    name: "reject/mt7-truncated-float",
    hex: "a3012619018b033a0001018cf93c",
    note: "`f9 3c`: a half float cut off by the end of the header",
    expect: reject(/unexpected end of input/),
  },
];

describe("ADR-0066 D9 protected-header conformance vectors", () => {
  it.each(HEADER_VECTORS.map((v): [string, HeaderVector] => [v.name, v]))(
    "%s",
    (_name, v) => {
      const bytes = fromHex(v.hex);
      expect(hex(bytes)).toBe(v.hex); // the row's hex is whole bytes
      if (v.expect.result === "accept") {
        expect(readProtectedTreeSize2(bytes)).toBe(v.expect.treeSize2);
      } else if (v.expect.result === "absent") {
        expect(readProtectedTreeSize2(bytes)).toBeNull();
      } else {
        expect(() => readProtectedTreeSize2(bytes)).toThrow(v.expect.why);
      }
    },
  );

  it("carries every row of the go-merklelog rejection table (4b1b789)", () => {
    // massifs/checkpointsign_test.go
    // TestProtectedHeaderTreeSizeRejectsNonCanonicalHeaders — the same bytes
    // must be rejected here, or a Go verifier and a TS verifier disagree on a
    // signed size. This table is a superset: the rows above it and below it
    // cover classes Go's reader gets from fxamacker's canonical check.
    const goRejects = [
      "a4012619018b033a0001018c043a0001018c08", // duplicate size label, 4 then 8
      "a3012619018b033a0001018c1a00000008", // non-canonical uint for 8
      "a3012619018b033a0001018c1808", // non-canonical uint for 8 (1 byte form)
      "bf012619018b033a0001018c08ff", // indefinite-length map
      "a33a0001018c0819018b030126", // reversed key order
      "a3012619018b033a0001018cc108", // tagged size
      "a3012619018b033a0001018cc24108", // bignum size
      "a3012619018b033a0001018cf94800", // float size
      "a3012619018b033a0001018c27", // negative size
      "a3012619018b033a0001018c0800", // trailing byte
    ];
    for (const h of goRejects) {
      const row = HEADER_VECTORS.find((v) => v.hex === h);
      expect(row, `no vector for go row ${h}`).toBeDefined();
      expect(row!.expect.result).toBe("reject");
    }
    // ...and the canonical form of the same map is accepted on both sides.
    expect(readProtectedTreeSize2(fromHex("a3012619018b033a0001018c08"))).toBe(
      8n,
    );
  });

  it("covers every class the amendment names", () => {
    // A guard on the table itself: a future edit that drops a class should
    // fail here rather than silently narrow the conformance surface.
    expect(HEADER_VECTORS).toHaveLength(29);
    expect(
      HEADER_VECTORS.filter((v) => v.expect.result === "reject"),
    ).toHaveLength(21);
    expect(new Set(HEADER_VECTORS.map((v) => v.name)).size).toBe(
      HEADER_VECTORS.length,
    );
  });
});

describe("major type 7 decoding", () => {
  it("decodes simple values and floats to their own types, never to a number", () => {
    // A float must not arrive as a JS number: a reader has to be able to tell
    // `f9 4800` (half 8.0) from `08` (the uint 8) before it trusts a size.
    const header = decodeCborDeterministicStrict(
      fromHex("a4012607f93c0019018b033a0001018c08"),
    ) as Map<number, unknown>;
    const skipped = header.get(7);
    expect(skipped).toBeInstanceOf(CborFloat);
    expect((skipped as CborFloat).value).toBe(1);
    expect(header.get(-65933)).toBe(8);

    const simple = decodeCborDeterministic(fromHex("f828"));
    expect(simple).toBeInstanceOf(CborSimple);
    expect((simple as CborSimple).value).toBe(40);

    // Immediate simple values 0–19 (20–23 are false/true/null/undefined).
    expect((decodeCborDeterministic(fromHex("f0")) as CborSimple).value).toBe(
      16,
    );
    expect(decodeCborDeterministic(fromHex("f4"))).toBe(false);
    expect(decodeCborDeterministic(fromHex("f5"))).toBe(true);
    expect(decodeCborDeterministic(fromHex("f6"))).toBeNull();
    expect(decodeCborDeterministic(fromHex("f7"))).toBeUndefined();

    // Half, single and double all decode; the value is the same 1.0.
    for (const h of ["f93c00", "fa3f800000", "fb3ff0000000000000"]) {
      const f = decodeCborDeterministic(fromHex(h));
      expect(f).toBeInstanceOf(CborFloat);
      expect((f as CborFloat).value).toBe(1);
    }
  });

  it("rejects the malformed major-type-7 forms as bare items too", () => {
    expect(() => decodeCborDeterministic(fromHex("fc"))).toThrow(
      /malformed additional info 28/,
    );
    expect(() => decodeCborDeterministic(fromHex("fd"))).toThrow(
      /malformed additional info 29/,
    );
    expect(() => decodeCborDeterministic(fromHex("fe"))).toThrow(
      /malformed additional info 30/,
    );
    expect(() => decodeCborDeterministic(fromHex("ff"))).toThrow(/break code/);
    expect(() => decodeCborDeterministic(fromHex("f81f"))).toThrow(/below 32/);
    expect(() => decodeCborDeterministic(fromHex("f93c"))).toThrow(
      /unexpected end of input/,
    );
  });
});

describe("tags: rejected in a header, decoded on an envelope", () => {
  it("the strict entry point rejects a tag at any depth", () => {
    // tag(18) [h'a10126', {}, null, h'00'] — a COSE_Sign1 envelope.
    const envelope = fromHex("d28443a10126a0f64100");
    expect(decodeCborDeterministic(envelope)).toBeInstanceOf(CborTag);
    expect(() => decodeCborDeterministicStrict(envelope)).toThrow(
      /tag 18 is not allowed/,
    );
    // Nested: {1: tag(2) h'08'}
    expect(() => decodeCborDeterministicStrict(fromHex("a101c24108"))).toThrow(
      /tag 2 is not allowed/,
    );
  });
});

describe("DIVERGENCE: length-first (ADR/contract) vs bytewise (Go) key order", () => {
  it("documents the one header class where the two canonical orders disagree", () => {
    // ADR-0066 D9 and univocity's `compareEncodedKeys`
    // (src/cosecbor/cosecbor.sol) sort the SHORTER key encoding first, then
    // bytewise. Go's fxamacker `SortCoreDeterministic` sorts purely bytewise.
    // They agree for every key pair in the estate's headers, and disagree
    // only when a 1-byte key's initial byte is greater than a longer key's:
    // -1 (`20`) beside 395 (`19 018b`) is the smallest such pair.
    //
    // {1: -7, -1: 0, 395: 3, -65933: 8}
    const lengthFirst = "a40126200019018b033a0001018c08"; // 01, 20, 19018b, 3a…
    const bytewise = "a4012619018b0320003a0001018c08"; // 01, 19018b, 20, 3a…

    // This package's decoder implements the ADR/contract rule.
    expect(readProtectedTreeSize2(fromHex(lengthFirst))).toBe(8n);
    expect(() => readProtectedTreeSize2(fromHex(bytewise))).toThrow(
      /out of canonical order/,
    );

    // This package's ENCODER sorts bytewise, byte-identical to Go — so for
    // this key class it emits a header its own decoder rejects. No sealer
    // header carries such a pair today; slice 06 has to settle which rule the
    // estate states, and whichever wins, both must state the same one.
    expect(
      hex(
        encodeCborDeterministic(
          new Map<number, number>([
            [1, -7],
            [-1, 0],
            [395, 3],
            [-65933, 8],
          ]),
        ),
      ),
    ).toBe(bytewise);
  });
});
