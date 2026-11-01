/**
 * Range-derived keys stay byte-identical across the move from JS number to
 * bigint bounds.
 *
 * `certificate_key` rows, pending natural keys and webhook `requestKey`
 * idempotency keys were built from JSON `number` bounds with template
 * interpolation. Built from `bigint` with `toString(10)` they must produce
 * the same strings for every value below 2^53, or existing stored keys stop
 * matching (re-submits would duplicate instead of upsert).
 */

import { describe, expect, it } from "vitest";
import { certificateKeyFor, sha256Hex } from "../../src/certificate-key.js";
import { materialKeyFor } from "../../src/material-key.js";
import { requestKeyFor } from "../../src/webhook/request-key.js";
import { testDelegatedCoseKey } from "./byok-material-fixture.js";

const LOG = "0123456789abcdef0123456789abcdef";

/** The earlier key shape, built from JS numbers. */
function legacyCertificateKey(
  start: number,
  end: number,
  hash: string,
): string {
  return `${start}:${end}:${hash}`;
}

describe("range key compatibility", () => {
  const ranges: Array<[number, number]> = [
    [0, 0],
    [0, 16383],
    [5, 7],
    [4294967296, 4294967297],
    [0, Number.MAX_SAFE_INTEGER],
  ];

  it.each(ranges)(
    "certificateKeyFor(%s, %s) matches the number-built key",
    async (start, end) => {
      const key = testDelegatedCoseKey(7);
      const hash = await sha256Hex(key);
      const expected = legacyCertificateKey(start, end, hash);
      expect(await certificateKeyFor(BigInt(start), BigInt(end), key)).toBe(
        expected,
      );
      expect(await materialKeyFor(BigInt(start), BigInt(end), key)).toBe(
        expected,
      );
    },
  );

  it.each(ranges)(
    "requestKeyFor(%s, %s) matches the number-built key",
    async (start, end) => {
      const pubHash = "ab".repeat(32);
      const expected = await sha256Hex(
        new TextEncoder().encode(`${LOG}:${start}:${end}:${pubHash}`),
      );
      expect(
        await requestKeyFor(LOG, BigInt(start), BigInt(end), pubHash),
      ).toBe(expected);
    },
  );

  it("pins one literal key so a format change cannot pass both sides", async () => {
    const key = await certificateKeyFor(5n, 16383n, new Uint8Array([1, 2, 3]));
    expect(key).toBe(
      "5:16383:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    );
    expect(
      await certificateKeyFor(
        (1n << 64n) - 1n,
        (1n << 64n) - 1n,
        new Uint8Array([1, 2, 3]),
      ),
    ).toBe(
      "18446744073709551615:18446744073709551615:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    );
  });
});
