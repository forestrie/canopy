import { describe, expect, it } from "vitest";
import { peakStackEnd } from "@forestrie/merklelog";
import {
  CACHE_CONTROL_IMMUTABLE,
  CACHE_CONTROL_NO_STORE,
  cacheControlForMassifDerived,
  massifDataComplete,
  massifTreeCount,
} from "../src/cbor-api/cache-policy.js";
import { cborResponse } from "../src/cbor-api/cbor-response.js";

const MASSIF_HEIGHT = 4;
const VALUE_BYTES = 32n;

/** Payload length encoding exactly `entries` log entries — all the predicate reads. */
function massifLen(height: number, entries: bigint): number {
  return Number(peakStackEnd(height) + entries * VALUE_BYTES);
}

describe("massifDataComplete", () => {
  const full = massifTreeCount(MASSIF_HEIGHT);

  it("treeCount is (1 << h) - 1", () => {
    expect(massifTreeCount(4)).toBe(15n);
    expect(massifTreeCount(14)).toBe(16383n);
  });

  it("an open massif is not complete", () => {
    expect(massifDataComplete(massifLen(MASSIF_HEIGHT, 0n), MASSIF_HEIGHT)).toBe(
      false,
    );
    expect(
      massifDataComplete(massifLen(MASSIF_HEIGHT, full - 1n), MASSIF_HEIGHT),
    ).toBe(false);
  });

  it("a full massif is complete", () => {
    expect(
      massifDataComplete(massifLen(MASSIF_HEIGHT, full), MASSIF_HEIGHT),
    ).toBe(true);
  });

  it("an undersized payload is never reported complete", () => {
    // massifLogEntries throws below the peak-stack end; content we cannot prove
    // is final must not be published immutable.
    expect(massifDataComplete(0, MASSIF_HEIGHT)).toBe(false);
    expect(
      massifDataComplete(Number(peakStackEnd(MASSIF_HEIGHT)) - 1, MASSIF_HEIGHT),
    ).toBe(false);
  });
});

describe("cacheControlForMassifDerived", () => {
  const full = massifTreeCount(MASSIF_HEIGHT);

  it("content from an open massif is never cached", () => {
    expect(
      cacheControlForMassifDerived(
        massifLen(MASSIF_HEIGHT, full - 1n),
        MASSIF_HEIGHT,
      ),
    ).toBe(CACHE_CONTROL_NO_STORE);
  });

  it("content from a complete massif is immutable", () => {
    expect(
      cacheControlForMassifDerived(massifLen(MASSIF_HEIGHT, full), MASSIF_HEIGHT),
    ).toBe(CACHE_CONTROL_IMMUTABLE);
  });
});

describe("cborResponse cache defaults", () => {
  it("defaults to no-store so immutability is never inherited", () => {
    // The previous default stamped every 2xx `immutable, max-age=31536000`,
    // which pinned mutable state such as revocation status for a year.
    const res = cborResponse({ tokens: [] }, 200);
    expect(res.headers.get("cache-control")).toBe(CACHE_CONTROL_NO_STORE);
  });

  it("errors are never cached", () => {
    const res = cborResponse({ title: "nope" }, 403);
    expect(res.headers.get("cache-control")).toBe(CACHE_CONTROL_NO_STORE);
  });

  it("an explicit directive still wins", () => {
    const res = cborResponse({ a: 1 }, 200, {
      "content-type": "application/cbor",
      "cache-control": CACHE_CONTROL_IMMUTABLE,
    });
    expect(res.headers.get("cache-control")).toBe(CACHE_CONTROL_IMMUTABLE);
  });
});
