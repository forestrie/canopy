import { describe, expect, it } from "vitest";
import {
  CACHE_CONTROL_IMMUTABLE,
  CACHE_CONTROL_NO_STORE,
  IMMUTABLE_HEADERS,
  NO_STORE_HEADERS,
} from "../src/cbor-api/cache-policy.js";
import { cborResponse } from "../src/cbor-api/cbor-response.js";

describe("cborResponse cache defaults", () => {
  it("defaults to no-store so immutability is never inherited", () => {
    // The previous default stamped every 2xx `immutable, max-age=31536000`,
    // which pinned mutable state such as revocation status for a year.
    const res = cborResponse({ tokens: [] }, 200);
    expect(res.headers.get("cache-control")).toBe(CACHE_CONTROL_NO_STORE);
  });

  it("errors are never cached", () => {
    for (const status of [400, 403, 404, 500]) {
      const res = cborResponse({ title: "nope" }, status);
      expect(res.headers.get("cache-control")).toBe(CACHE_CONTROL_NO_STORE);
    }
  });

  it("an explicit directive still wins", () => {
    const res = cborResponse({ a: 1 }, 200, {
      "content-type": "application/cbor",
      ...IMMUTABLE_HEADERS,
    });
    expect(res.headers.get("cache-control")).toBe(CACHE_CONTROL_IMMUTABLE);
  });

  it("spreading NO_STORE_HEADERS is equivalent to the default", () => {
    const res = cborResponse({ a: 1 }, 200, {
      "content-type": "application/cbor",
      ...NO_STORE_HEADERS,
    });
    expect(res.headers.get("cache-control")).toBe(CACHE_CONTROL_NO_STORE);
  });
});

describe("policy constants", () => {
  // Only genesis is immutable. Receipts are not: a receipt is derived from the
  // massif AND the latest checkpoint for it, and the sealer can re-seal a
  // complete massif (ADR-0056/ADR-0057), so a cached receipt could pin a
  // superseded proof and defeat FOR-418 freshening.
  it("immutable is a one-year immutable directive", () => {
    expect(CACHE_CONTROL_IMMUTABLE).toBe("public, max-age=31536000, immutable");
  });

  it("no-store, not no-cache — a transient answer must not be stored at all", () => {
    expect(CACHE_CONTROL_NO_STORE).toBe("no-store");
  });
});
