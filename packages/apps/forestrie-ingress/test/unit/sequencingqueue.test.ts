import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import type { SequencingQueueStub } from "@canopy/forestrie-ingress-types";

// Cast env to our Env type (it's provided by the test pool from wrangler.jsonc)
const testEnv = env as unknown as Env;

describe("SequencingQueue Durable Object", () => {
  // Helper to get a fresh DO stub with a unique name per test
  // We cast to SequencingQueueStub since the DO namespace typing is generic
  function getStub(testName: string): SequencingQueueStub {
    const id = testEnv.SEQUENCING_QUEUE.idFromName(testName);
    return testEnv.SEQUENCING_QUEUE.get(id) as unknown as SequencingQueueStub;
  }

  it("can be instantiated via idFromName('global')", async () => {
    const stub = getStub("global");
    expect(stub).toBeDefined();
  });

  it("stats returns empty stats on fresh instance", async () => {
    const stub = getStub("stats-test");
    const stats = await stub.stats();

    expect(stats).toEqual({
      pending: 0,
      deadLetters: 0,
      oldestEntryAgeMs: null,
      activePollers: 0,
    });
  });

  it("pull returns empty response when queue is empty", async () => {
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

  // Phase 2: enqueue() tests
  describe("enqueue()", () => {
    it("returns incrementing seq numbers", async () => {
      const stub = getStub("enqueue-seq-test");
      const logId = new Uint8Array(16).fill(0x01).buffer;
      const contentHash = new Uint8Array(32).fill(0xaa).buffer;

      const result1 = await stub.enqueue(logId, contentHash);
      const result2 = await stub.enqueue(logId, contentHash);
      const result3 = await stub.enqueue(logId, contentHash);

      expect(result1.seq).toBe(1);
      expect(result2.seq).toBe(2);
      expect(result3.seq).toBe(3);
    });

    it("persists entries and updates stats", async () => {
      const stub = getStub("enqueue-persist-test");
      const logId = new Uint8Array(16).fill(0x02).buffer;
      const contentHash = new Uint8Array(32).fill(0xbb).buffer;

      // Initially empty
      let stats = await stub.stats();
      expect(stats.pending).toBe(0);

      // Enqueue two entries
      await stub.enqueue(logId, contentHash);
      await stub.enqueue(logId, contentHash);

      // Stats should reflect pending count
      stats = await stub.stats();
      expect(stats.pending).toBe(2);
      expect(stats.oldestEntryAgeMs).toBeGreaterThanOrEqual(0);
    });

    it("accepts optional extras within size limit", async () => {
      const stub = getStub("enqueue-extras-test");
      const logId = new Uint8Array(16).fill(0x03).buffer;
      const contentHash = new Uint8Array(32).fill(0xcc).buffer;
      const extra0 = new Uint8Array(32).fill(0x11).buffer; // Max allowed
      const extra1 = new Uint8Array(16).fill(0x22).buffer; // Under limit

      const result = await stub.enqueue(logId, contentHash, { extra0, extra1 });
      expect(result.seq).toBe(1);
    });
  });

  // Phase 2: ackRange() tests
  describe("ackRange()", () => {
    it("deletes entries in range and returns count", async () => {
      const stub = getStub("ack-range-test");
      const logId = new Uint8Array(16).fill(0x04).buffer;
      const contentHash = new Uint8Array(32).fill(0xdd).buffer;

      // Enqueue 5 entries
      await stub.enqueue(logId, contentHash);
      await stub.enqueue(logId, contentHash);
      await stub.enqueue(logId, contentHash);
      await stub.enqueue(logId, contentHash);
      await stub.enqueue(logId, contentHash);

      let stats = await stub.stats();
      expect(stats.pending).toBe(5);

      // Ack entries 2-4
      const result = await stub.ackRange(logId, 2, 4);
      expect(result.deleted).toBe(3);

      // Stats should reflect remaining
      stats = await stub.stats();
      expect(stats.pending).toBe(2);
    });

    it("only deletes entries for specified logId", async () => {
      const stub = getStub("ack-logid-test");
      const logId1 = new Uint8Array(16).fill(0x05).buffer;
      const logId2 = new Uint8Array(16).fill(0x06).buffer;
      const contentHash = new Uint8Array(32).fill(0xee).buffer;

      // Enqueue 2 entries per log
      await stub.enqueue(logId1, contentHash);
      await stub.enqueue(logId1, contentHash);
      await stub.enqueue(logId2, contentHash);
      await stub.enqueue(logId2, contentHash);

      let stats = await stub.stats();
      expect(stats.pending).toBe(4);

      // Ack only logId1's entries
      const result = await stub.ackRange(logId1, 1, 2);
      expect(result.deleted).toBe(2);

      // logId2's entries should remain
      stats = await stub.stats();
      expect(stats.pending).toBe(2);
    });

    it("returns 0 when range matches no entries", async () => {
      const stub = getStub("ack-empty-test");
      const logId = new Uint8Array(16).fill(0x07).buffer;

      const result = await stub.ackRange(logId, 1, 10);
      expect(result.deleted).toBe(0);
    });
  });

  // Phase 2: stats() tests (beyond initial empty test)
  describe("stats()", () => {
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
      await stub.enqueue(logId, contentHash);
      await stub.enqueue(logId, contentHash);
      await stub.enqueue(logId, contentHash);

      stats = await stub.stats();
      expect(stats.pending).toBe(3);
      expect(stats.oldestEntryAgeMs).toBeGreaterThanOrEqual(0);

      // Ack some
      await stub.ackRange(logId, 1, 2);

      stats = await stub.stats();
      expect(stats.pending).toBe(1);
    });
  });

  // Phase 2: ensureSchema() idempotency test
  describe("ensureSchema()", () => {
    it("is idempotent - multiple calls do not error", async () => {
      const stub = getStub("schema-idempotent-test");

      // Multiple operations should work (each calls ensureSchema internally)
      await stub.stats();
      await stub.stats();

      const logId = new Uint8Array(16).fill(0x09).buffer;
      const contentHash = new Uint8Array(32).fill(0x00).buffer;
      await stub.enqueue(logId, contentHash);
      await stub.stats();

      // If we got here without error, schema is idempotent
      expect(true).toBe(true);
    });
  });

  // Phase 3: pull() tests
  describe("pull()", () => {
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
        (g) => new Uint8Array(g.logId)[0] === 0x10
      );
      const group2 = response.logGroups.find(
        (g) => new Uint8Array(g.logId)[0] === 0x11
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
        0
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
        new Uint8Array(32).fill(0xff)
      );
      expect(new Uint8Array(entry.extra0!)).toEqual(
        new Uint8Array(16).fill(0x11)
      );
      expect(new Uint8Array(entry.extra1!)).toEqual(
        new Uint8Array(8).fill(0x22)
      );
      expect(entry.extra2).toBeNull();
      expect(entry.extra3).toBeNull();
    });
  });
});
