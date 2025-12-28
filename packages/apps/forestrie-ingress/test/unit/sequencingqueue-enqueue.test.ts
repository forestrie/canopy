/**
 * SequencingQueue enqueue() tests.
 */

import { describe, expect, it } from "vitest";
import { getStub } from "./sequencingqueue-fixture";

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
});
