/**
 * SequencingQueue ackFirst() tests.
 *
 * Tests limit-based acknowledgement which is required because seq values are
 * allocated globally across all logs, making per-log seq values non-contiguous.
 * See: arbor/docs/arc-cloudflare-do-ingress.md section 2.3
 */

import { describe, expect, it } from "vitest";
import { getStub } from "./sequencingqueue-fixture";
import { retainedEntryCount } from "../../src/durableobjects/retention";

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
    const result = await stub.ackFirst(logId, seq1.seq, 3, 0n, 14);
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
    const result = await stub.ackFirst(logIdA, seqA1.seq, 2, 0n, 14);
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
    const result = await stub.ackFirst(logId1, seq1.seq, 2, 0n, 14);
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

    const result = await stub.ackFirst(logId, 1, 0, 0n, 14);
    expect(result.acked).toBe(0);

    const stats = await stub.stats();
    expect(stats.pending).toBe(1);
  });

  it("returns 0 when no entries match seqLo", async () => {
    const stub = getStub("ack-first-empty-test");
    const logId = new Uint8Array(16).fill(0x46).buffer;

    const result = await stub.ackFirst(logId, 1, 10, 0n, 14);
    expect(result.acked).toBe(0);
  });

  it("handles double ack gracefully (returns 0)", async () => {
    const stub = getStub("ack-first-double-test");
    const logId = new Uint8Array(16).fill(0x47).buffer;
    const contentHash = new Uint8Array(32).fill(0xdd).buffer;

    const { seq } = await stub.enqueue(logId, contentHash);

    // First ack marks the entry as sequenced
    const result1 = await stub.ackFirst(logId, seq, 1, 0n, 14);
    expect(result1.acked).toBe(1);

    // Second ack on same params should return 0 (already sequenced)
    const result2 = await stub.ackFirst(logId, seq, 1, 0n, 14);
    expect(result2.acked).toBe(0);

    // Stats should still show 0 pending
    const stats = await stub.stats();
    expect(stats.pending).toBe(0);
  });
});

describe("SequencingQueue ackFirst massif height (FOR-620)", () => {
  // massifHeight is one-based: a massif holds 2^(h-1) leaves (go-merklelog
  // urkle.LeafCountForMassifHeight). The DO stores only the leaf index;
  // readers derive the massif from it.

  it("resolveContent returns the leaf index and no stored massif index", async () => {
    const stub = getStub("ack-first-resolve-leaf-only");
    const logId = new Uint8Array(16).fill(0x48).buffer;
    const contentHash = new Uint8Array(32).fill(0x62).buffer;

    const { seq } = await stub.enqueue(logId, contentHash);
    await stub.ackFirst(logId, seq, 1, 8192n, 14);

    expect(await stub.resolveContent(contentHash)).toEqual({
      leafIndex: 8192n,
    });
  });

  // ackFirst calls retainedEntryCount before any write. A throw out of the DO
  // breaks vitest-pool-workers isolated storage, so the guard is tested on
  // the pure function rather than through the stub.
  it("retainedEntryCount sizes 4 massifs and rejects a bad height", () => {
    expect(retainedEntryCount(3)).toBe(16);
    expect(retainedEntryCount(14)).toBe(32768);
    expect(() => retainedEntryCount(14.5)).toThrow(RangeError);
    expect(() => retainedEntryCount(0)).toThrow(RangeError);
  });

  it("retains four massifs of sequenced entries at 2^(h-1) leaves each", async () => {
    const stub = getStub("ack-first-retention-height");
    const logId = new Uint8Array(16).fill(0x49).buffer;
    const massifHeight = 3; // 4 leaves per massif -> retain 16 behind the max

    const hashes = Array.from(
      { length: 30 },
      (_, i) => new Uint8Array(32).fill(i).buffer,
    );
    let firstSeq = 0;
    for (const [i, contentHash] of hashes.entries()) {
      const { seq } = await stub.enqueue(logId, contentHash);
      if (i === 0) firstSeq = seq;
    }
    await stub.ackFirst(logId, firstSeq, 30, 0n, massifHeight);

    const retained: bigint[] = [];
    for (const contentHash of hashes) {
      const result = await stub.resolveContent(contentHash);
      if (result) retained.push(result.leafIndex);
    }

    // Max leaf 29; entries with leaf_index < 29 - 16 are dropped, so the
    // max and the 16 behind it (17 rows) remain.
    expect(retained).toEqual(
      Array.from({ length: 17 }, (_, i) => BigInt(13 + i)),
    );
  });
});
