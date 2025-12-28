/**
 * SequencingQueue pull() tests.
 */

import { describe, expect, it } from "vitest";
import { getStub } from "./sequencingqueue-fixture";

describe("SequencingQueue pull", () => {
  it("returns empty response when queue is empty", async () => {
    const stub = getStub("pull-empty-test");
    const response = await stub.pull({
      pollerId: "test-poller",
      batchSize: 100,
      visibilityMs: 30000,
    });

    expect(response.version).toBe(1);
    expect(response.logGroups).toEqual([]);
    expect(response.leaseExpiry).toBeGreaterThan(Date.now());
  });

  it("single poller pulls all entries grouped by logId", async () => {
    const stub = getStub("pull-single-poller-test");
    const logId1 = new Uint8Array(16).fill(0x10).buffer;
    const logId2 = new Uint8Array(16).fill(0x11).buffer;
    const contentHash1 = new Uint8Array(32).fill(0xaa).buffer;
    const contentHash2 = new Uint8Array(32).fill(0xbb).buffer;

    // Enqueue entries for two logs
    await stub.enqueue(logId1, contentHash1);
    await stub.enqueue(logId1, contentHash1);
    await stub.enqueue(logId2, contentHash2);

    const response = await stub.pull({
      pollerId: "poller-1",
      batchSize: 100,
      visibilityMs: 30000,
    });

    expect(response.version).toBe(1);
    expect(response.logGroups.length).toBe(2);

    // Find log groups by logId
    const group1 = response.logGroups.find(
      (g) => new Uint8Array(g.logId)[0] === 0x10,
    );
    const group2 = response.logGroups.find(
      (g) => new Uint8Array(g.logId)[0] === 0x11,
    );

    expect(group1).toBeDefined();
    expect(group1!.seqLo).toBe(1);
    expect(group1!.seqHi).toBe(2);
    expect(group1!.entries.length).toBe(2);

    expect(group2).toBeDefined();
    expect(group2!.seqLo).toBe(3);
    expect(group2!.seqHi).toBe(3);
    expect(group2!.entries.length).toBe(1);
  });

  it("pulled entries become invisible until lease expires", async () => {
    const stub = getStub("pull-visibility-test");
    const logId = new Uint8Array(16).fill(0x12).buffer;
    const contentHash = new Uint8Array(32).fill(0xcc).buffer;

    await stub.enqueue(logId, contentHash);
    await stub.enqueue(logId, contentHash);

    // First pull should get entries
    const response1 = await stub.pull({
      pollerId: "poller-1",
      batchSize: 100,
      visibilityMs: 30000,
    });
    expect(response1.logGroups.length).toBe(1);
    expect(response1.logGroups[0].entries.length).toBe(2);

    // Second pull should get empty (entries are invisible)
    const response2 = await stub.pull({
      pollerId: "poller-1",
      batchSize: 100,
      visibilityMs: 30000,
    });
    expect(response2.logGroups.length).toBe(0);
  });

  it("respects batchSize limit", async () => {
    const stub = getStub("pull-batchsize-test");
    const logId = new Uint8Array(16).fill(0x13).buffer;
    const contentHash = new Uint8Array(32).fill(0xdd).buffer;

    // Enqueue more than batch size
    for (let i = 0; i < 10; i++) {
      await stub.enqueue(logId, contentHash);
    }

    const response = await stub.pull({
      pollerId: "poller-1",
      batchSize: 5,
      visibilityMs: 30000,
    });

    const totalEntries = response.logGroups.reduce(
      (sum, g) => sum + g.entries.length,
      0,
    );
    expect(totalEntries).toBe(5);
  });

  it("reports active pollers in stats", async () => {
    const stub = getStub("pull-poller-stats-test");
    const logId = new Uint8Array(16).fill(0x14).buffer;
    const contentHash = new Uint8Array(32).fill(0xee).buffer;

    await stub.enqueue(logId, contentHash);

    // Initial stats - no pollers
    let stats = await stub.stats();
    expect(stats.activePollers).toBe(0);

    // Pull registers the poller
    await stub.pull({
      pollerId: "poller-1",
      batchSize: 100,
      visibilityMs: 30000,
    });

    stats = await stub.stats();
    expect(stats.activePollers).toBe(1);

    // Another poller
    await stub.pull({
      pollerId: "poller-2",
      batchSize: 100,
      visibilityMs: 30000,
    });

    stats = await stub.stats();
    expect(stats.activePollers).toBe(2);
  });

  it("returns entries with extras preserved", async () => {
    const stub = getStub("pull-extras-test");
    const logId = new Uint8Array(16).fill(0x15).buffer;
    const contentHash = new Uint8Array(32).fill(0xff).buffer;
    const extra0 = new Uint8Array(16).fill(0x11).buffer;
    const extra1 = new Uint8Array(8).fill(0x22).buffer;

    await stub.enqueue(logId, contentHash, { extra0, extra1 });

    const response = await stub.pull({
      pollerId: "poller-1",
      batchSize: 100,
      visibilityMs: 30000,
    });

    expect(response.logGroups.length).toBe(1);
    const entry = response.logGroups[0].entries[0];
    expect(new Uint8Array(entry.contentHash)).toEqual(
      new Uint8Array(32).fill(0xff),
    );
    expect(new Uint8Array(entry.extra0!)).toEqual(
      new Uint8Array(16).fill(0x11),
    );
    expect(new Uint8Array(entry.extra1!)).toEqual(new Uint8Array(8).fill(0x22));
    expect(entry.extra2).toBeNull();
    expect(entry.extra3).toBeNull();
  });

  it("redelivers entries after visibility timeout expires", async () => {
    const stub = getStub("pull-redelivery-test");
    const logId = new Uint8Array(16).fill(0x16).buffer;
    const contentHash = new Uint8Array(32).fill(0xaa).buffer;

    await stub.enqueue(logId, contentHash);

    // Pull with very short visibility (1ms)
    const response1 = await stub.pull({
      pollerId: "poller-1",
      batchSize: 100,
      visibilityMs: 1,
    });
    expect(response1.logGroups.length).toBe(1);

    // Wait for visibility to expire
    await new Promise((r) => setTimeout(r, 10));

    // Should redeliver the entry
    const response2 = await stub.pull({
      pollerId: "poller-1",
      batchSize: 100,
      visibilityMs: 30000,
    });
    expect(response2.logGroups.length).toBe(1);
    expect(response2.logGroups[0].entries.length).toBe(1);
  });

  it("multiple pollers see only their assigned logs", async () => {
    const stub = getStub("pull-multi-poller-test");
    const contentHash = new Uint8Array(32).fill(0xbb).buffer;

    // Enqueue entries for many logs to ensure distribution
    const logIds: ArrayBuffer[] = [];
    for (let i = 0; i < 20; i++) {
      const logId = new Uint8Array(16);
      logId[0] = i;
      logId[1] = (i * 7) & 0xff; // Add some variation
      logIds.push(logId.buffer);
      await stub.enqueue(logId.buffer, contentHash);
    }

    // First poller pulls
    const response1 = await stub.pull({
      pollerId: "poller-a",
      batchSize: 100,
      visibilityMs: 30000,
    });

    // Second poller pulls (different poller ID)
    const response2 = await stub.pull({
      pollerId: "poller-b",
      batchSize: 100,
      visibilityMs: 30000,
    });

    // Both pollers should get some logs
    const logs1 = new Set(response1.logGroups.map((g) => g.logId));
    const logs2 = new Set(response2.logGroups.map((g) => g.logId));

    // Total should cover all 20 logs (since each is in one poller's response)
    const totalLogs = response1.logGroups.length + response2.logGroups.length;
    expect(totalLogs).toBe(20);

    // No overlap (each log assigned to exactly one poller)
    for (const log of logs1) {
      // Check that log2 doesn't contain same logId bytes
      const found = Array.from(logs2).some((l) =>
        new Uint8Array(l).every((b, i) => b === new Uint8Array(log)[i]),
      );
      expect(found).toBe(false);
    }
  });

  it("moves entry to dead_letters after MAX_ATTEMPTS (5)", async () => {
    const stub = getStub("pull-deadletter-test");
    const logId = new Uint8Array(16).fill(0x17).buffer;
    const contentHash = new Uint8Array(32).fill(0xcc).buffer;

    await stub.enqueue(logId, contentHash);

    // Pull 5 times (MAX_ATTEMPTS) with expired visibility to allow re-pull
    for (let i = 0; i < 5; i++) {
      const response = await stub.pull({
        pollerId: "poller-1",
        batchSize: 100,
        visibilityMs: 1, // Very short visibility
      });
      // Entry should be returned (or already moved to dead letters on 5th)
      if (i < 4) {
        expect(response.logGroups.length).toBe(1);
      }
      await new Promise((r) => setTimeout(r, 5));
    }

    // After 5 attempts, next pull should trigger move to dead letters
    const finalResponse = await stub.pull({
      pollerId: "poller-1",
      batchSize: 100,
      visibilityMs: 30000,
    });
    expect(finalResponse.logGroups.length).toBe(0);

    // Stats should show dead letter
    const stats = await stub.stats();
    expect(stats.pending).toBe(0);
    expect(stats.deadLetters).toBe(1);
  });
});
