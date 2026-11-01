/**
 * Golden bytes for every grant v0 wire encoder. arbor (go-univocity) and the
 * univocity contract hash these bytes, so moving the encoders onto
 * `encodeCborDeterministic` must leave them byte-identical. The vectors were
 * captured from the hand-rolled writers before that change (FOR-619 S5).
 *
 * `maxHeight` and `minGrowth` are CBOR major type 0. Every value up to
 * 2^53-1 encodes in shortest form; the old exported `appendCborUint` had no
 * 8-byte branch and truncated anything at or above 2^32 to its low 4 bytes.
 */

import { describe, expect, it } from "vitest";
import {
  decodeGrantPayload,
  encodeGrantForResponse,
  encodeGrantPayload,
  encodeGrantRequest,
} from "./index.js";
import { encodeGrantPayloadV0Canonical } from "./grant-payload-canonical.js";
import type { Grant } from "./grant.js";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

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

  it.each([-1, 1.5, Number.NaN, Infinity, 2 ** 53])(
    "rejects maxHeight %s instead of emitting a wrong uint",
    (v) => {
      expect(() => encode(grantWith(v, 0))).toThrow(/maxHeight/);
      expect(() => encode(grantWith(0, v))).toThrow(/minGrowth/);
    },
  );
});

describe("decodeGrantPayload uint bounds", () => {
  const bytes = (uintHex: string): Uint8Array =>
    Buffer.from(
      PAYLOAD_PREFIX + uintHex + "05" + "00" + GRANT_DATA_SUFFIX,
      "hex",
    );

  it("decodes maxHeight 2^53-1 exactly", () => {
    expect(decodeGrantPayload(bytes("1b001fffffffffffff")).maxHeight).toBe(
      2 ** 53 - 1,
    );
  });

  // Grant.maxHeight is a number; 2^53+1 used to decode as 2^53.
  it.each(["1b0020000000000000", "1b0020000000000001", "1bffffffffffffffff"])(
    "rejects maxHeight %s rather than rounding it",
    (uintHex) => {
      expect(() => decodeGrantPayload(bytes(uintHex))).toThrow(/2\^53-1/);
    },
  );
});
