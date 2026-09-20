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
 * Where D9 as quoted is broader than go-merklelog's canonical re-encode, the
 * decoder follows go-merklelog: CBOR `undefined` is rejected everywhere, and a
 * float is accepted only in its shortest exactly-representable width (NaN only
 * as `f9 7e00`) — the ADR amendment that narrows D9 to match is tracked in
 * plan-2609-10 slice 01.
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
 * band pinned at the end of this file.
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
    // Narrowed by forestrie/protocol#10 (2026-09-20): D9 as originally
    // quoted at the top of this file let an unread label carry any
    // well-formed major-type-7 value, simple(40) included. The
    // cross-language KAT (checkpoint-receipt-kat39.test.ts,
    // row reject/mt7-simple-40) pins go-merklelog's narrowed behaviour —
    // only false, true and null survive among major-type-7 values — so this
    // row moved from accept to reject to match. See
    // isAllowedHeaderValue in cose-protected-tree-size.ts.
    name: "reject/mt7-simple-40",
    hex: "a4012607f82819018b033a0001018c08",
    note: "`07 f8 28`: two-byte simple value 40; only false, true and null are allowed under an unread label",
    expect: reject(/excluded value type/),
  },
  {
    name: "skip/mt7-half-float-1.0",
    hex: "a4012607f93c0019018b033a0001018c08",
    note: "`07 f9 3c00`: half float 1.0",
    expect: accept(8n),
  },
  {
    name: "skip/mt7-half-nan",
    hex: "a4012607f97e0019018b033a0001018c08",
    note: "`07 f9 7e00`: the one NaN encoding that survives NaNConvert7e00",
    expect: accept(8n),
  },
  {
    name: "skip/mt7-half-inf",
    hex: "a4012607f97c0019018b033a0001018c08",
    note: "`07 f9 7c00`: +Inf; the half is its shortest exact width",
    expect: accept(8n),
  },
  {
    name: "skip/mt7-double-float-1e300",
    hex: "a4012607fb7e37e43c880759db19018b033a0001018c08",
    note: "`07 fb 7e37e43c880759db`: 1.0000000000671607e300 (the review's `1e300` row; 1e300 exactly is `...759c`), exact in neither half nor single, so the double IS its shortest form",
    expect: accept(8n),
  },

  // ---- floats: only the shortest exact width -----------------------------
  // go-merklelog's decodeProtectedHeader re-encodes the header with
  // canonicalReceiptCBOR = cbor.CanonicalEncOptions() (ShortestFloat16,
  // NaNConvert7e00) and requires byte equality, so a single or double that
  // has a shorter exact form, and any NaN that is not `f9 7e00`, re-encode
  // to different bytes and are rejected there. Accepting them here would put
  // a checkpoint on-chain that no Go replica can re-verify (review H1).
  {
    name: "reject/mt7-single-float-1.0",
    hex: "a4012607fa3f80000019018b033a0001018c08",
    note: "`07 fa 3f800000`: single 1.0; exact as the half `f9 3c00`",
    expect: reject(/not in shortest form/),
  },
  {
    name: "reject/mt7-double-float-1.0",
    hex: "a4012607fb3ff000000000000019018b033a0001018c08",
    note: "`07 fb 3ff0000000000000`: double 1.0; exact as the half `f9 3c00`",
    expect: reject(/not in shortest form/),
  },
  {
    name: "reject/mt7-double-nan",
    hex: "a4012607fb7ff800000000000019018b033a0001018c08",
    note: "`07 fb 7ff8000000000000`: double NaN; every NaN re-encodes as `f9 7e00`",
    expect: reject(/not in shortest form/),
  },
  {
    name: "reject/mt7-single-inf",
    hex: "a4012607fa7f80000019018b033a0001018c08",
    note: "`07 fa 7f800000`: +Inf as a single; exact as the half `f9 7c00`",
    expect: reject(/not in shortest form/),
  },
  {
    name: "reject/mt7-double-inf",
    hex: "a4012607fb7ff000000000000019018b033a0001018c08",
    note: "`07 fb 7ff0000000000000`: +Inf as a double; exact as the half `f9 7c00`",
    expect: reject(/not in shortest form/),
  },

  // ---- undefined ----------------------------------------------------------
  {
    name: "reject/mt7-undefined",
    hex: "a4012607f719018b033a0001018c08",
    note: "`07 f7`: CBOR undefined; go-merklelog decodes it to Go nil and re-encodes it as `f6` (null), so no header carrying it is canonical there",
    expect: reject(/undefined \(0xf7\) is not allowed/),
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

  // ---- labels must be integers -------------------------------------------
  // D9 bounds integer key magnitude but never says labels must be integers.
  // go-merklelog unmarshals the header into map[int64]any and the univocity
  // parser reads every label with readInteger, so both reject these; before
  // review H4 this reader read a size from all three. The generic decoder
  // still accepts a text-keyed map — plain-object encoding produces one —
  // so the check lives in readProtectedTreeSize2, not in the decoder.
  {
    name: "reject/key-tstr",
    hex: "a4012619018b03627879003a0001018c08",
    note: '{1: -7, 395: 3, "xy": 0, -65933: 8}; `627879` is a 3-byte text key, canonically ordered, so the order check does not catch it',
    expect: reject(/label is not an integer/),
  },
  {
    name: "reject/key-empty-tstr",
    hex: "a40126600019018b033a0001018c08",
    note: '{1: -7, "": 0, 395: 3, -65933: 8}; `60` is the empty text string as a label',
    expect: reject(/label is not an integer/),
  },
  {
    name: "reject/key-empty-array",
    hex: "a40126800019018b033a0001018c08",
    note: "{1: -7, []: 0, 395: 3, -65933: 8}; `80` is an empty array as a label",
    expect: reject(/label is not an integer/),
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

  it("accepts every header go-merklelog is known to accept (the converse direction)", () => {
    // The rejection table above is one-directional: it only checks that this
    // reader rejects what Go rejects. Review finding H1 lived entirely in
    // that gap — canopy accepted three header classes Go rejects, and nothing
    // asserted the other direction. GO_ACCEPTS closes it: a header Go reads a
    // size from must yield the same size here, or the chain can anchor a
    // checkpoint one of the two verifiers refuses.
    //
    // Go's outcome for each row was originally recorded by running
    // `ProtectedHeaderTreeSize` from a go-merklelog clone against these exact
    // bytes, under the adversarial review's PoC harness
    // (`review-canopy255/poc/d3-header/gml-clone/massifs`, local to the
    // review tree, not committed here) — a one-off snapshot, not something
    // this suite could keep in sync with go-merklelog itself. Slice 06 (the
    // FOR-568 rollout) replaced that recorded snapshot with the committed
    // cross-language KAT (checkpoint-receipt-kat39.test.ts), which runs the
    // same bytes through go-merklelog in CI on the vector's own side
    // (`gen_checkpoint_receipt_kat39.py` asserts against go-merklelog's KAT
    // tables before emitting). That KAT is now authoritative: forestrie/
    // protocol#10 narrowed D9 after this table was recorded, so
    // simple(40)/array/map under an unread label moved from accept to
    // reject on the Go side too (see checkpoint-receipt-kat39.json rows
    // reject/mt7-simple-40, reject/array-under-unread-label,
    // reject/map-under-unread-label) — GO_ACCEPTS below reflects that, and
    // GO_REJECTS_NARROWED names the three rows this table used to carry as
    // accepted before the narrowing.
    const GO_ACCEPTS: readonly (readonly [string, string, bigint])[] = [
      // the two canonical sealer headers
      ["canonical/size-8", "a3012619018b033a0001018c08", 8n],
      ["canonical/size-1", "a3012619018b033a0001018c01", 1n],
      // major type 7 under the unread label 7, in the forms Go round-trips
      ["skip/mt7-half-float-1.0", "a4012607f93c0019018b033a0001018c08", 8n],
      ["skip/mt7-false", "a4012607f419018b033a0001018c08", 8n],
      // non-mt7 values under the unread label
      ["skip/bstr-empty", "a40126074019018b033a0001018c08", 8n],
      ["skip/tstr-x", "a4012607617819018b033a0001018c08", 8n],
    ];
    for (const [name, h, size] of GO_ACCEPTS) {
      expect(readProtectedTreeSize2(fromHex(h)), name).toBe(size);
    }

    const GO_REJECTS_NARROWED: readonly (readonly [string, string])[] = [
      ["skip/mt7-simple-40", "a4012607f82819018b033a0001018c08"],
      ["skip/array-empty", "a40126078019018b033a0001018c08"],
      ["skip/map-empty", "a4012607a019018b033a0001018c08"],
    ];
    for (const [name, h] of GO_REJECTS_NARROWED) {
      expect(() => readProtectedTreeSize2(fromHex(h)), name).toThrow(
        /excluded value type/,
      );
    }
  });

  it("covers every class the amendment names", () => {
    // A guard on the table itself: a future edit that drops a class should
    // fail here rather than silently narrow the conformance surface.
    expect(HEADER_VECTORS).toHaveLength(40);
    expect(
      HEADER_VECTORS.filter((v) => v.expect.result === "reject"),
    ).toHaveLength(31);
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
    // Go round-trips the simple values byte-identically (verified: `f0` and
    // `f8 28` under an unread label are both accepted there), so they stay.
    expect((decodeCborDeterministic(fromHex("f0")) as CborSimple).value).toBe(
      16,
    );
    expect(decodeCborDeterministic(fromHex("f4"))).toBe(false);
    expect(decodeCborDeterministic(fromHex("f5"))).toBe(true);
    expect(decodeCborDeterministic(fromHex("f6"))).toBeNull();

    // `f7` (undefined) is the one major-type-7 form that is not round-tripped:
    // go-merklelog decodes it to Go nil and re-encodes it as `f6`, so a header
    // carrying it is never canonical there. Rejected here too.
    expect(() => decodeCborDeterministic(fromHex("f7"))).toThrow(
      /undefined \(0xf7\) is not allowed/,
    );

    // 1.0 is exact as a half, so only `f9 3c00` decodes; the single and the
    // double forms re-encode shorter under fxamacker's ShortestFloat16 and
    // are rejected.
    const one = decodeCborDeterministic(fromHex("f93c00"));
    expect(one).toBeInstanceOf(CborFloat);
    expect((one as CborFloat).value).toBe(1);
    for (const h of ["fa3f800000", "fb3ff0000000000000"]) {
      expect(() => decodeCborDeterministic(fromHex(h))).toThrow(
        /not in shortest form/,
      );
    }
  });

  it("accepts a float only in its shortest exactly-representable width", () => {
    // RFC 8949 §4.2.2 preferred serialization as fxamacker implements it
    // (ShortestFloat16 + NaNConvert7e00), which is the rule go-merklelog's
    // canonical re-encode of a protected header enforces. Every row below was
    // checked against go-merklelog with the review's PoC harness
    // (`review-canopy255/poc/d3-header/gml-clone/massifs`), each value placed
    // under the unread label 7 of the canonical sealer header.
    const SHORTEST: readonly (readonly [string, string, number])[] = [
      // half is enough: normals, subnormals, ±0, ±Inf, the canonical NaN
      ["half 1.0", "f93c00", 1],
      ["half 1.5", "f93e00", 1.5],
      ["half 3.5", "f94300", 3.5],
      ["half -2.0", "f9c000", -2],
      ["half 65504 (largest finite half)", "f97bff", 65504],
      ["half 2^-24 (smallest half subnormal)", "f90001", 2 ** -24],
      ["half +0.0", "f90000", 0],
      ["half -0.0", "f98000", -0],
      ["half +Inf", "f97c00", Infinity],
      ["half -Inf", "f9fc00", -Infinity],
      // single is the shortest exact width
      ["single 2^-25 (below the half subnormal floor)", "fa33000000", 2 ** -25],
      ["single 65536 (beyond the half range)", "fa47800000", 65536],
      ["single 3.4028234663852886e38", "fa7f7fffff", 3.4028234663852886e38],
      // double is the shortest exact width
      ["double 0.1", "fb3fb999999999999a", 0.1],
      ["double 1/3", "fb3fd5555555555555", 1 / 3],
      // The review's "1e300" row: these bytes are 1.0000000000671607e300, not
      // 1e300 exactly (1e300 is `fb 7e37e43c8800759c`). Same class either
      // way — exact in neither half nor single — and kept verbatim so the row
      // matches the review's H1 table and the recorded Go run.
      [
        "double 1.0000000000671607e300",
        "fb7e37e43c880759db",
        1.0000000000671607e300,
      ],
      ["double 16777217 (not exact in single)", "fb4170000010000000", 16777217],
    ];
    for (const [name, h, value] of SHORTEST) {
      const f = decodeCborDeterministic(fromHex(h));
      expect(f, name).toBeInstanceOf(CborFloat);
      expect((f as CborFloat).value, name).toBe(value);
    }

    const NOT_SHORTEST: readonly (readonly [string, string])[] = [
      ["single 1.0 → half", "fa3f800000"],
      ["double 1.0 → half", "fb3ff0000000000000"],
      ["single 0.125 → half", "fa3e000000"],
      ["single +0.0 → half", "fa00000000"],
      ["single +Inf → half", "fa7f800000"],
      ["double +Inf → half", "fb7ff0000000000000"],
      ["double 2^-25 → single", "fb3e60000000000000"],
      ["double 3.4028234663852886e38 → single", "fb47efffffe0000000"],
      // every NaN re-encodes as f9 7e00, so only f9 7e00 itself survives
      ["single NaN → f97e00", "fa7fc00000"],
      ["double NaN → f97e00", "fb7ff8000000000000"],
      ["half NaN payload 7e01 → f97e00", "f97e01"],
    ];
    for (const [name, h] of NOT_SHORTEST) {
      expect(() => decodeCborDeterministic(fromHex(h)), name).toThrow(
        /not in shortest form/,
      );
    }

    // ...and the one NaN that is preferred decodes.
    expect(
      (decodeCborDeterministic(fromHex("f97e00")) as CborFloat).value,
    ).toBeNaN();
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

describe("canonical key order: length-first, then bytewise", () => {
  it("encoder and decoder agree on the divergence band, and it is the order every verifier applies", () => {
    // Canonical order for a Forestrie header is length-first, then bytewise
    // (RFC 7049 §3.9). ADR-0066 D9 states it; go-merklelog's
    // decodeProtectedHeader re-encodes with canonicalReceiptCBOR =
    // cbor.CanonicalEncOptions() (Sort: SortCanonical), which is that rule;
    // and the univocity parser's `compareEncodedKeys`
    // (src/cosecbor/cosecbor.sol, on the unmerged branch of univocity PR #43,
    // not on main) is the same comparator. fxamacker's SortCoreDeterministic
    // — RFC 8949 §4.2.1, pure bytewise — lives in massifs/cbor/config.go and
    // is a different encoder that never touches a checkpoint header.
    //
    // The two orders differ only when a map mixes a negative label encoded
    // strictly shorter than a positive one. {1: -7, -1: 0, 395: 3, -65933: 8}
    // is the smallest such header: -1 is `20` (1 byte), 395 is `19 018b`
    // (3 bytes).
    const lengthFirst = "a40126200019018b033a0001018c08"; // 01, 20, 19018b, 3a…
    const bytewise = "a4012619018b0320003a0001018c08"; // 01, 19018b, 20, 3a…

    // Recorded from the review's PoC harness against go-merklelog: the
    // length-first bytes are ACCEPT 8 there and the bytewise bytes are
    // rejected as "not canonical cbor". This reader agrees with both.
    expect(readProtectedTreeSize2(fromHex(lengthFirst))).toBe(8n);
    expect(() => readProtectedTreeSize2(fromHex(bytewise))).toThrow(
      /out of canonical order/,
    );

    // The encoder emits the same order it reads: before `compareCanonicalKeys`
    // was shared it sorted bytewise and emitted `bytewise` here, bytes its own
    // decoder rejected (review E1).
    const encoded = encodeCborDeterministic(
      new Map<number, number>([
        [1, -7],
        [-1, 0],
        [395, 3],
        [-65933, 8],
      ]),
    );
    expect(hex(encoded)).toBe(lengthFirst);
    expect(readProtectedTreeSize2(encoded)).toBe(8n);
  });
});
