import { describe, expect, it } from "vitest";
import {
  deriveMassifCacheKey,
  parseMassifCoordinateFromKey,
} from "../../src/massifs";

describe("massifs helpers", () => {
  it("parses massif coordinates from canonical R2_MMRS keys", () => {
    const coordinate = parseMassifCoordinateFromKey(
      "logs/log-123/massifs/42.cbor",
    );

    expect(coordinate).toEqual({ logId: "log-123", index: 42 });
  });

  it("returns null for non-massif keys", () => {
    expect(
      parseMassifCoordinateFromKey("logs/log-123/other/42.cbor"),
    ).toBeNull();
  });

  it("derives cache keys from massif coordinates", () => {
    const cacheKey = deriveMassifCacheKey({ logId: "log-abc", index: 7 });
    expect(cacheKey).toBe("logs/log-abc/massifs/7");
  });
});
