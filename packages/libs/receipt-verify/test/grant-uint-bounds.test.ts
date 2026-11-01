/**
 * The offline verifier must accept exactly the grant uints canopy admission
 * accepts: both convert maxHeight / minGrowth with `grantUintFromCbor`
 * (`@forestrie/encoding`). A uint a JS number cannot hold exactly would
 * round, and the grant commitment would hash a different value from arbor's.
 */
import { encodeCborDeterministic } from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
import { decodeGrantPayload, decodeGrantResponse } from "../src/grant-codec.js";

function payloadMap(maxHeight: number | bigint): Map<number, unknown> {
  return new Map<number, unknown>([
    [1, new Uint8Array(32).fill(1)],
    [2, new Uint8Array(32).fill(2)],
    [3, new Uint8Array(8)],
    [4, maxHeight],
    [5, 0],
    [6, new Uint8Array(0)],
  ]);
}

const decoders = [
  [
    "decodeGrantPayload",
    (v: number | bigint) =>
      decodeGrantPayload(encodeCborDeterministic(payloadMap(v))),
  ],
  [
    "decodeGrantResponse",
    (v: number | bigint) =>
      decodeGrantResponse(
        encodeCborDeterministic(
          new Map([[0, new Uint8Array(8)], ...payloadMap(v)]),
        ),
      ).grant,
  ],
] as const;

describe.each(decoders)("%s maxHeight bounds", (_, decode) => {
  it.each([
    [(1n << 53n) - 1n, 2 ** 53 - 1],
    [1n << 60n, 2 ** 60],
  ])("decodes %s exactly", (wire, expected) => {
    expect(decode(wire).maxHeight).toBe(expected);
  });

  it.each([(1n << 53n) + 1n, (1n << 64n) - 1n, -1])(
    "rejects %s rather than rounding or accepting it",
    (wire) => {
      expect(() => decode(wire)).toThrow(/maxHeight/);
    },
  );
});
