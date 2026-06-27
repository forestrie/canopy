/**
 * Payload field 5 contract tests — inline integer-key COSE_Key rules shared
 * with arbor
 * [delegationcert](https://github.com/forestrie/arbor/tree/main/services/pkgs/delegationcert)
 * and plan-0024 BYOK checkpoint seal RCA.
 */

import { describe, expect, it } from "vitest";
import {
  assertDelegatedKeyInCertificate,
  parseDelegatedCoseKeyFromPayload,
} from "../src/index.js";
import { encodeIntKeyCbor } from "../src/encode-int-map.js";
import {
  COSE_CRV,
  COSE_CRV_P256,
  COSE_KTY,
  COSE_KTY_EC2,
  COSE_X,
  COSE_Y,
} from "../src/payload-labels.js";

describe("delegated COSE_Key payload field 5", () => {
  it("rejects bstr field 5", () => {
    const keyBytes = encodeIntKeyCbor(
      new Map<number, unknown>([
        [COSE_KTY, COSE_KTY_EC2],
        [COSE_CRV, COSE_CRV_P256],
        [COSE_X, new Uint8Array(32)],
        [COSE_Y, new Uint8Array(32)],
      ]),
    );
    expect(() => parseDelegatedCoseKeyFromPayload(keyBytes)).toThrow(
      /inline integer-key/,
    );
  });

  it("rejects non-integer map keys", () => {
    expect(() => parseDelegatedCoseKeyFromPayload({ foo: 1, bar: 2 })).toThrow(
      /not an integer/,
    );
  });

  it("accepts inline integer-key EC2 map", () => {
    const inline = new Map<number, unknown>([
      [COSE_KTY, COSE_KTY_EC2],
      [COSE_CRV, COSE_CRV_P256],
      [COSE_X, new Uint8Array(32).fill(1)],
      [COSE_Y, new Uint8Array(32).fill(2)],
    ]);
    const parsed = parseDelegatedCoseKeyFromPayload(inline);
    expect(parsed.x[0]).toBe(1);
    expect(parsed.y[0]).toBe(2);
  });
});

describe("assertDelegatedKeyInCertificate", () => {
  it("throws on malformed certificate array", () => {
    const bad = encodeIntKeyCbor([1, 2, 3]);
    expect(() => assertDelegatedKeyInCertificate(bad)).toThrow(/COSE_Sign1/);
  });
});
