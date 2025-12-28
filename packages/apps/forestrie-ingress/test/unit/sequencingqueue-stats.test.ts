/**
 * SequencingQueue stats() tests.
 */

import { describe, expect, it } from "vitest";
import { getStub } from "./sequencingqueue-fixture";

describe("SequencingQueue stats", () => {
  it("returns empty stats on fresh instance", async () => {
    const stub = getStub("stats-test");
    const stats = await stub.stats();

    expect(stats).toEqual({
      pending: 0,
      deadLetters: 0,
      oldestEntryAgeMs: null,
      activePollers: 0,
      pollerLimitReached: false,
    });
  });

  it("reflects counts after enqueue and ack operations", async () => {
    const stub = getStub("stats-operations-test");
    const logId = new Uint8Array(16).fill(0x08).buffer;
    const contentHash = new Uint8Array(32).fill(0xff).buffer;

    // Initially empty
    let stats = await stub.stats();
    expect(stats.pending).toBe(0);
    expect(stats.deadLetters).toBe(0);
    expect(stats.oldestEntryAgeMs).toBeNull();

    // Enqueue entries
    const seq1 = await stub.enqueue(logId, contentHash);
    await stub.enqueue(logId, contentHash);
    await stub.enqueue(logId, contentHash);

    stats = await stub.stats();
    expect(stats.pending).toBe(3);
    expect(stats.oldestEntryAgeMs).toBeGreaterThanOrEqual(0);

    // Ack some using limit-based ack
    await stub.ackFirst(logId, seq1.seq, 2, 0, 14);

    stats = await stub.stats();
    expect(stats.pending).toBe(1);
  });
});
