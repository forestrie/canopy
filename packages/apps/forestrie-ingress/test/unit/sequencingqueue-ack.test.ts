/**
 * SequencingQueue ackFirst() tests.
 *
 * Tests limit-based acknowledgement which is required because seq values are
 * allocated globally across all logs, making per-log seq values non-contiguous.
 * See: arbor/docs/arc-cloudflare-do-ingress.md section 2.3
 */

import { describe, expect, it } from "vitest";
import { getStub } from "./sequencingqueue-fixture";

describe("SequencingQueue ackFirst", () => {
  it("deletes first N entries for log and returns count", async () => {
    const stub = getStub("ack-first-test");
    const logId = new Uint8Array(16).fill(0x40).buffer;
    const contentHash = new Uint8Array(32).fill(0xdd).buffer;

    // Enqueue 5 entries
    const seq1 = await stub.enqueue(logId, contentHash);
    await stub.enqueue(logId, contentHash);
    await stub.enqueue(logId, contentHash);
    await stub.enqueue(logId, contentHash);
    await stub.enqueue(logId, contentHash);

    let stats = await stub.stats();
    expect(stats.pending).toBe(5);

    // Ack first 3 entries starting from seq1
    const result = await stub.ackFirst(logId, seq1.seq, 3, 0, 14);
    expect(result.acked).toBe(3);

    // Stats should reflect remaining
    stats = await stub.stats();
    expect(stats.pending).toBe(2);
  });

  it("handles non-contiguous seq values correctly", async () => {
    const stub = getStub("ack-first-noncontig-test");
    const logIdA = new Uint8Array(16).fill(0x41).buffer;
    const logIdB = new Uint8Array(16).fill(0x42).buffer;
    const contentHash = new Uint8Array(32).fill(0xdd).buffer;

    // Interleave entries from two logs to create non-contiguous seq per log
    // Global seq: 1(A), 2(B), 3(A), 4(B), 5(A)
    const seqA1 = await stub.enqueue(logIdA, contentHash); // seq 1
    await stub.enqueue(logIdB, contentHash); // seq 2
    await stub.enqueue(logIdA, contentHash); // seq 3
    await stub.enqueue(logIdB, contentHash); // seq 4
    await stub.enqueue(logIdA, contentHash); // seq 5

    // Ack first 2 entries for logA starting from seqA1
    // Should mark entries with seq 1 and 3 as sequenced (the first 2 for logA)
    const result = await stub.ackFirst(logIdA, seqA1.seq, 2, 0, 14);
    expect(result.acked).toBe(2);

    // Should have 3 entries left (1 for logA, 2 for logB)
    const stats = await stub.stats();
    expect(stats.pending).toBe(3);
  });

  it("only deletes entries for specified logId", async () => {
    const stub = getStub("ack-first-logid-test");
    const logId1 = new Uint8Array(16).fill(0x43).buffer;
    const logId2 = new Uint8Array(16).fill(0x44).buffer;
    const contentHash = new Uint8Array(32).fill(0xee).buffer;

    // Enqueue 2 entries per log
    const seq1 = await stub.enqueue(logId1, contentHash);
    await stub.enqueue(logId1, contentHash);
    await stub.enqueue(logId2, contentHash);
    await stub.enqueue(logId2, contentHash);

    let stats = await stub.stats();
    expect(stats.pending).toBe(4);

    // Ack only logId1's entries
    const result = await stub.ackFirst(logId1, seq1.seq, 2, 0, 14);
    expect(result.acked).toBe(2);

    // logId2's entries should remain
    stats = await stub.stats();
    expect(stats.pending).toBe(2);
  });

  it("returns 0 when limit is 0", async () => {
    const stub = getStub("ack-first-zero-test");
    const logId = new Uint8Array(16).fill(0x45).buffer;
    const contentHash = new Uint8Array(32).fill(0xdd).buffer;

    await stub.enqueue(logId, contentHash);

    const result = await stub.ackFirst(logId, 1, 0, 0, 14);
    expect(result.acked).toBe(0);

    const stats = await stub.stats();
    expect(stats.pending).toBe(1);
  });

  it("returns 0 when no entries match seqLo", async () => {
    const stub = getStub("ack-first-empty-test");
    const logId = new Uint8Array(16).fill(0x46).buffer;

    const result = await stub.ackFirst(logId, 1, 10, 0, 14);
    expect(result.acked).toBe(0);
  });

  it("handles double ack gracefully (returns 0)", async () => {
    const stub = getStub("ack-first-double-test");
    const logId = new Uint8Array(16).fill(0x47).buffer;
    const contentHash = new Uint8Array(32).fill(0xdd).buffer;

    const { seq } = await stub.enqueue(logId, contentHash);

    // First ack marks the entry as sequenced
    const result1 = await stub.ackFirst(logId, seq, 1, 0, 14);
    expect(result1.acked).toBe(1);

    // Second ack on same params should return 0 (already sequenced)
    const result2 = await stub.ackFirst(logId, seq, 1, 0, 14);
    expect(result2.acked).toBe(0);

    // Stats should still show 0 pending
    const stats = await stub.stats();
    expect(stats.pending).toBe(0);
  });
});
