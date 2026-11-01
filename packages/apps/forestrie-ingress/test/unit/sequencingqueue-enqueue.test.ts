/**
 * SequencingQueue enqueue() tests.
 */

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SequencingQueue } from "../../src/durableobjects/sequencingqueue";
import { getStub, testEnv } from "./sequencingqueue-fixture";

describe("SequencingQueue enqueue", () => {
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

  // Skip: vitest pool workers has issues with isolated storage when DO throws
  it.skip("rejects extra fields exceeding 32 bytes", async () => {
    const stub = getStub("enqueue-extras-reject-test");
    const logId = new Uint8Array(16).fill(0x03).buffer;
    const contentHash = new Uint8Array(32).fill(0xcc).buffer;
    const oversizedExtra = new Uint8Array(33).fill(0xff).buffer; // 1 byte over

    let error: Error | undefined;
    try {
      await stub.enqueue(logId, contentHash, { extra0: oversizedExtra });
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toContain("exceeds maximum size");
  });

  // Runs inside the DO with runInDurableObject: a throw that crosses the
  // RPC stub breaks vitest-pool-workers isolated storage (see the skipped
  // extras test above).
  it("rejects a content hash that is not 32 bytes", async () => {
    const ns = testEnv.SEQUENCING_QUEUE;
    const stub = ns.get(ns.idFromName("enqueue-content-hash-reject-test"));
    const logId = new Uint8Array(16).fill(0x04).buffer;

    await runInDurableObject(stub, async (queue: SequencingQueue) => {
      for (const len of [0, 31, 33]) {
        const contentHash = new Uint8Array(len).fill(0xdd).buffer;
        await expect(queue.enqueue(logId, contentHash)).rejects.toThrow(
          "contentHash must be 32 bytes",
        );
      }
      // Nothing was queued, so a bad entry cannot block the log.
      expect((await queue.stats()).pending).toBe(0);
    });
  });

  // Note: Testing QueueFullError at MAX_PENDING (100,000) is impractical in unit tests.
  // The QueueFullError class itself is tested via types and the error is thrown
  // in the enqueue() method when pendingCount >= MAX_PENDING.
  // Integration/load tests should verify the 503 response behavior.
});
