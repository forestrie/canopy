/**
 * Golden bytes for every grant v0 wire encoder. arbor (go-univocity) and the
 * univocity contract hash these bytes, so moving the encoders onto
 * `encodeCborDeterministic` must leave them byte-identical (FOR-619 S5).
 *
 * The representative grant, the padding and length-head cases, and the uint
 * rows below 2^32 were captured from the hand-rolled writers before that
 * change. The uint rows from 2^32 up are written by hand from RFC 8949 §3.1:
 * the old exported `appendCborUint` (behind `encodeGrantPayloadV0Canonical`)
 * had no 8-byte branch and truncated them to their low 4 bytes.
 *
 * `maxHeight` and `minGrowth` are JS numbers. Any integer number denotes one
 * exact value, so every non-negative integer below 2^64 encodes exactly;
 * negative, fractional, NaN and infinite values, and 2^64 itself, throw. On
 * decode, a uint that a number cannot hold exactly (it would round) throws.
 */

import { describe, expect, it } from "vitest";
import {
  decodeGrantPayload,
  decodeGrantResponse,
  encodeGrantForResponse,
  encodeGrantPayload,
  encodeGrantRequest,
} from "./index.js";
import { encodeGrantPayloadV0Canonical } from "./grant-payload-canonical.js";
import type { Grant } from "./grant.js";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const encodePayload = (g: Grant): Uint8Array => encodeGrantPayload(g);

function grantWith(maxHeight: number, minGrowth: number): Grant {
  return {
    logId: Uint8Array.from({ length: 16 }, (_, i) => 0x10 + i),
    ownerLogId: Uint8Array.from({ length: 16 }, (_, i) => 0x20 + i),
    grant: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 3]),
    maxHeight,
    minGrowth,
    grantData: Uint8Array.from({ length: 64 }, (_, i) => i),
  };
}

const IDTIMESTAMP = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);

/** map(6), keys 1-3 (log ids left-padded to 32 bytes, 8-byte flags), key 4. */
const PAYLOAD_PREFIX =
  "a6" +
  "01" +
  "5820" +
  "00000000000000000000000000000000" +
  "101112131415161718191a1b1c1d1e1f" +
  "02" +
  "5820" +
  "00000000000000000000000000000000" +
  "202122232425262728292a2b2c2d2e2f" +
  "03" +
  "48" +
  "0000000000000003" +
  "04";

/** map(7) with key 0 = 8-byte idtimestamp, then the same keys 1-4. */
const RESPONSE_PREFIX =
  "a7" + "00" + "48" + "0102030405060708" + PAYLOAD_PREFIX.slice(2);

/** key 6: 64-byte grantData. */
const GRANT_DATA_SUFFIX =
  "06" +
  "5840" +
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f" +
  "202122232425262728292a2b2c2d2e2f" +
  "303132333435363738393a3b3c3d3e3f";

/** Shortest-form CBOR major type 0, written out by hand (RFC 8949 §3.1). */
const UINT_VECTORS: [number, string][] = [
  [0, "00"],
  [23, "17"],
  [24, "1818"],
  [255, "18ff"],
  [256, "190100"],
  [65535, "19ffff"],
  [65536, "1a00010000"],
  [2 ** 32 - 1, "1affffffff"],
  [2 ** 32, "1b0000000100000000"],
  [2 ** 53 - 1, "1b001fffffffffffff"],
  [2 ** 60, "1b1000000000000000"],
  [2 ** 63, "1b8000000000000000"],
];

const ENCODERS: [string, (g: Grant) => Uint8Array, string][] = [
  [
    "encodeGrantPayloadV0Canonical",
    encodeGrantPayloadV0Canonical,
    PAYLOAD_PREFIX,
  ],
  ["encodeGrantPayload", encodeGrantPayload, PAYLOAD_PREFIX],
  [
    "encodeGrantRequest",
    (g) => encodeGrantRequest(g as Parameters<typeof encodeGrantRequest>[0]),
    PAYLOAD_PREFIX,
  ],
  [
    "encodeGrantForResponse",
    (g) => encodeGrantForResponse(g, IDTIMESTAMP),
    RESPONSE_PREFIX,
  ],
];

describe.each(ENCODERS)("%s golden bytes", (_, encode, prefix) => {
  it("pins the full encoding of a representative grant", () => {
    expect(hex(encode(grantWith(14, 300)))).toBe(
      prefix + "0e" + "05" + "19012c" + GRANT_DATA_SUFFIX,
    );
  });

  it.each(UINT_VECTORS)(
    "encodes maxHeight and minGrowth %s as %s",
    (v, uintHex) => {
      expect(hex(encode(grantWith(v, v)))).toBe(
        prefix + uintHex + "05" + uintHex + GRANT_DATA_SUFFIX,
      );
    },
  );

  it.each([-1, 1.5, Number.NaN, Infinity, 2 ** 64])(
    "rejects maxHeight %s instead of emitting a wrong uint",
    (v) => {
      expect(() => encode(grantWith(v, 0))).toThrow(/maxHeight/);
      expect(() => encode(grantWith(0, v))).toThrow(/minGrowth/);
    },
  );
});

describe.each([
  [
    "decodeGrantPayload",
    (h: string) => decodeGrantPayload(Buffer.from(h, "hex")),
  ],
  [
    "decodeGrantResponse",
    (h: string) =>
      decodeGrantResponse(
        Buffer.from(
          "a7" + "00" + "48" + "0102030405060708" + h.slice(2),
          "hex",
        ),
      ).grant,
  ],
] as const)("%s uint bounds", (_, decode) => {
  // Key 4 (maxHeight) and key 5 (minGrowth) each carry the value under test.
  const FIELDS = [
    ["maxHeight", (u: string) => PAYLOAD_PREFIX + u + "05" + "00"],
    ["minGrowth", (u: string) => PAYLOAD_PREFIX + "00" + "05" + u],
  ] as const;

  describe.each(FIELDS)("%s", (field, head) => {
    const payload = (uintHex: string): string =>
      head(uintHex) + GRANT_DATA_SUFFIX;

    it.each([
      ["1b001fffffffffffff", 2 ** 53 - 1],
      ["1b1000000000000000", 2 ** 60],
    ])("decodes %s exactly", (uintHex, expected) => {
      expect(decode(payload(uintHex))[field]).toBe(expected);
    });

    // A number cannot hold these exactly (2^53+1 rounds to 2^53, 2^64-1 to
    // 2^64), so they are rejected. "20" is CBOR -1 (major type 1, decoded as
    // a number); "3b0fffffffffffffff" is -2^60 (decoded as a bigint).
    it.each([
      "1b0020000000000001",
      "1bffffffffffffffff",
      "20",
      "3b0fffffffffffffff",
    ])("rejects %s rather than rounding or accepting it", (uintHex) => {
      expect(() => decode(payload(uintHex))).toThrow(new RegExp(field));
    });
  });
});

/** Padding, truncation and length-head cases the representative grant misses. */
describe("grant wire padding and lengths", () => {
  const base = grantWith(14, 300);
  const tail = (gdHead: string, gd: Uint8Array): string =>
    "0e" + "05" + "19012c" + "06" + gdHead + hex(gd);

  it("pads a 32-byte logId differently in encodeGrantRequest (leftPad) and encodeGrantPayload (toPaddedWire32)", () => {
    const logId32 = Uint8Array.from([
      ...new Uint8Array(16).fill(0xaa),
      ...base.logId,
    ]);
    const g = { ...base, logId: logId32 };
    const req = hex(
      encodeGrantRequest(g as Parameters<typeof encodeGrantRequest>[0]),
    );
    const pay = hex(encodePayload(g));
    expect(req.slice(0, 2 + 2 + 4 + 64)).toBe(
      "a6" +
        "01" +
        "5820" +
        "aa".repeat(16) +
        "101112131415161718191a1b1c1d1e1f",
    );
    expect(pay.slice(0, 2 + 2 + 4 + 64)).toBe(
      "a6" +
        "01" +
        "5820" +
        "00".repeat(16) +
        "101112131415161718191a1b1c1d1e1f",
    );
  });

  it("keeps the low 8 bytes of longer flags and left-pads a short idtimestamp", () => {
    const g = { ...base, grant: Uint8Array.from([9, 0, 0, 0, 0, 0, 0, 0, 3]) };
    expect(hex(encodePayload(g))).toBe(
      PAYLOAD_PREFIX + tail("5840", base.grantData as Uint8Array),
    );
    expect(
      hex(encodeGrantForResponse(base, Uint8Array.from([1, 2, 3, 4, 5, 6, 7]))),
    ).toBe(
      "a7" +
        "00" +
        "48" +
        "00010203040506" +
        "07" +
        PAYLOAD_PREFIX.slice(2) +
        tail("5840", base.grantData as Uint8Array),
    );
  });

  it.each([
    [0, "40"],
    [23, "57"],
    [24, "5818"],
    [255, "58ff"],
    [256, "590100"],
  ])("emits grantData of length %s with head %s", (n, head) => {
    const gd = Uint8Array.from({ length: n }, (_, i) => i & 0xff);
    const g = { ...base, grantData: gd };
    for (const encode of [encodePayload, encodeGrantPayloadV0Canonical]) {
      expect(hex(encode(g))).toBe(PAYLOAD_PREFIX + tail(head, gd));
    }
  });

  it("encodeGrantRequest normalises a structured grantData to its bytes", () => {
    const xy = base.grantData as Uint8Array;
    const g = { ...base, grantData: { kind: "es256-xy", xy } };
    expect(
      hex(
        encodeGrantRequest(
          g as unknown as Parameters<typeof encodeGrantRequest>[0],
        ),
      ),
    ).toBe(PAYLOAD_PREFIX + tail("5840", xy));
  });

  it("encodes Buffer subarrays with a nonzero byteOffset as their own bytes", () => {
    const backing = Buffer.alloc(64, 0xee);
    Buffer.from(base.logId as Uint8Array).copy(backing, 4);
    const g = { ...base, logId: backing.subarray(4, 20) };
    expect(hex(encodePayload(g))).toBe(hex(encodePayload(base)));
  });
});
