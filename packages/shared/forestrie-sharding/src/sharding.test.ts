import { describe, it, expect } from "vitest";
import {
  hashLogId,
  shardIndexForLog,
  shardNameForIndex,
  shardNameForLog,
} from "./sharding.js";

describe("hashLogId", () => {
  it("returns consistent hash for same input", () => {
    const logId = "550e8400-e29b-41d4-a716-446655440000";
    const hash1 = hashLogId(logId);
    const hash2 = hashLogId(logId);
    expect(hash1).toBe(hash2);
  });

  it("returns different hashes for different inputs", () => {
    const hash1 = hashLogId("550e8400-e29b-41d4-a716-446655440000");
    const hash2 = hashLogId("550e8400-e29b-41d4-a716-446655440001");
    expect(hash1).not.toBe(hash2);
  });

  it("returns unsigned 32-bit integer", () => {
    const logId = "test-log-id";
    const hash = hashLogId(logId);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });

  it("handles empty string", () => {
    const hash = hashLogId("");
    expect(hash).toBe(5381); // djb2 initial value
  });
});

describe("shardIndexForLog", () => {
  it("returns index in valid range", () => {
    const logId = "550e8400-e29b-41d4-a716-446655440000";
    const shardCount = 4;
    const index = shardIndexForLog(logId, shardCount);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(shardCount);
  });

  it("returns consistent index for same input", () => {
    const logId = "550e8400-e29b-41d4-a716-446655440000";
    const index1 = shardIndexForLog(logId, 4);
    const index2 = shardIndexForLog(logId, 4);
    expect(index1).toBe(index2);
  });

  it("distributes logs across shards", () => {
    const shardCount = 4;
    const counts = new Array(shardCount).fill(0);

    // Generate 1000 unique log IDs and count distribution
    for (let i = 0; i < 1000; i++) {
      const logId = `log-${i.toString().padStart(6, "0")}`;
      const index = shardIndexForLog(logId, shardCount);
      counts[index]++;
    }

    // Each shard should have at least 150 logs (expect ~250 each)
    for (const count of counts) {
      expect(count).toBeGreaterThan(150);
    }
  });

  it("throws for shardCount < 1", () => {
    expect(() => shardIndexForLog("test", 0)).toThrow(
      "shardCount must be >= 1",
    );
    expect(() => shardIndexForLog("test", -1)).toThrow(
      "shardCount must be >= 1",
    );
  });

  it("handles shardCount of 1", () => {
    const index = shardIndexForLog("any-log-id", 1);
    expect(index).toBe(0);
  });
});

describe("shardNameForIndex", () => {
  it("returns correct format", () => {
    expect(shardNameForIndex(0)).toBe("shard-0");
    expect(shardNameForIndex(1)).toBe("shard-1");
    expect(shardNameForIndex(99)).toBe("shard-99");
  });
});

describe("shardNameForLog", () => {
  it("combines index calculation and naming", () => {
    const logId = "550e8400-e29b-41d4-a716-446655440000";
    const shardCount = 4;
    const name = shardNameForLog(logId, shardCount);

    // Should match manual calculation
    const index = shardIndexForLog(logId, shardCount);
    expect(name).toBe(`shard-${index}`);
  });

  it("returns consistent name for same input", () => {
    const logId = "550e8400-e29b-41d4-a716-446655440000";
    const name1 = shardNameForLog(logId, 4);
    const name2 = shardNameForLog(logId, 4);
    expect(name1).toBe(name2);
  });
});
