import { describe, expect, it } from "vitest";
import { shardIndexForLog, shardNameForIndex } from "@canopy/forestrie-sharding";
import { hex32ToCanonicalUuid } from "../../src/log-id.js";

describe("shard routing for coordinator logs", () => {
  it("routes the same log id to a stable shard index", () => {
    const hex32 = "550e8400e29b41d4a716446655440000";
    const uuid = hex32ToCanonicalUuid(hex32);
    const shardCount = 4;

    const indexA = shardIndexForLog(uuid, shardCount);
    const indexB = shardIndexForLog(uuid, shardCount);

    expect(indexA).toBe(indexB);
    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexA).toBeLessThan(shardCount);
    expect(shardNameForIndex(indexA)).toBe(`shard-${indexA}`);
  });
});
