/**
 * SequencingQueue ackFirst() tests.
 *
 * Ack is limit-based because seq values are allocated globally across all
 * logs, making per-log seq values non-contiguous (see
 * arbor/docs/arc-cloudflare-do-ingress.md section 2.3). It names the batch a
 * pull leased, and is refused unless exactly `limit` rows are still pending
 * under that lease (FOR-655).
 */

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  assignLog,
  type SequencingQueue,
} from "../../src/durableobjects/sequencingqueue";
import { getStub, testEnv } from "./sequencingqueue-fixture";
import { retainedEntryCount } from "../../src/durableobjects/retention";
import { ackOf, batchFor, pullBatch, pullBatches } from "../pulledbatch";

const hash = (b: number) => new Uint8Array(32).fill(b).buffer;

describe("SequencingQueue ackFirst", () => {
  it("marks the pulled batch sequenced and returns its count", async () => {
    const stub = getStub("ack-first-test");
    const logId = new Uint8Array(16).fill(0x40).buffer;
    for (let i = 0; i < 5; i++) await stub.enqueue(logId, hash(0xdd));

    const batch = await pullBatch(stub, logId, { batchSize: 3 });
    expect(batch.count).toBe(3);

    const result = await stub.ackFirst(ackOf(batch, 0n));
    expect(result.acked).toBe(3);
    expect((await stub.stats()).pending).toBe(2);
  });

  it("acks only the log's rows within a non-contiguous seq range", async () => {
    const stub = getStub("ack-first-noncontig-test");
    const logIdA = new Uint8Array(16).fill(0x41).buffer;
    const logIdB = new Uint8Array(16).fill(0x42).buffer;

    // Global seq: 1(A), 2(B), 3(A), 4(B), 5(A): A's batch spans seq 1..5.
    await stub.enqueue(logIdA, hash(0xdd));
    await stub.enqueue(logIdB, hash(0xdd));
    await stub.enqueue(logIdA, hash(0xdd));
    await stub.enqueue(logIdB, hash(0xdd));
    await stub.enqueue(logIdA, hash(0xdd));

    const batchA = batchFor(await pullBatches(stub), logIdA);
    expect(batchA).toMatchObject({ seqLo: 1, seqHi: 5, count: 3 });

    const result = await stub.ackFirst(ackOf(batchA, 0n));
    expect(result.acked).toBe(3);
    expect((await stub.stats()).pending).toBe(2);
  });

  it("only marks entries for the specified logId", async () => {
    const stub = getStub("ack-first-logid-test");
    const logId1 = new Uint8Array(16).fill(0x43).buffer;
    const logId2 = new Uint8Array(16).fill(0x44).buffer;
    await stub.enqueue(logId1, hash(0xee));
    await stub.enqueue(logId1, hash(0xee));
    await stub.enqueue(logId2, hash(0xee));
    await stub.enqueue(logId2, hash(0xee));

    const batches = await pullBatches(stub);
    const result = await stub.ackFirst(ackOf(batchFor(batches, logId1), 0n));
    expect(result.acked).toBe(2);
    expect((await stub.stats()).pending).toBe(2);
  });

  it("returns 0 when limit is 0", async () => {
    const stub = getStub("ack-first-zero-test");
    const logId = new Uint8Array(16).fill(0x45).buffer;
    await stub.enqueue(logId, hash(0xdd));

    const batch = await pullBatch(stub, logId);
    const result = await stub.ackFirst(ackOf(batch, 0n, 14, 0));
    expect(result.acked).toBe(0);
    expect((await stub.stats()).pending).toBe(1);
  });

  it("returns 0 for a batch that was never pulled", async () => {
    const stub = getStub("ack-first-empty-test");
    const logId = new Uint8Array(16).fill(0x46).buffer;
    await stub.enqueue(logId, hash(0xdd));

    const result = await stub.ackFirst({
      logId,
      seqLo: 1,
      seqHi: 1,
      leaseExpiry: Date.now() + 30000,
      limit: 1,
      firstLeafIndex: 0n,
      massifHeight: 14,
    });
    expect(result.acked).toBe(0);
    expect((await stub.stats()).pending).toBe(1);
  });

  it("returns 0 for a second ack of the same batch", async () => {
    const stub = getStub("ack-first-double-test");
    const logId = new Uint8Array(16).fill(0x47).buffer;
    await stub.enqueue(logId, hash(0xdd));

    const ack = ackOf(await pullBatch(stub, logId), 0n);
    expect((await stub.ackFirst(ack)).acked).toBe(1);
    expect((await stub.ackFirst(ack)).acked).toBe(0);
    expect((await stub.stats()).pending).toBe(0);
  });
});

describe("SequencingQueue ackFirst is bound to its lease (FOR-655)", () => {
  it("refuses a partial ack and marks nothing", async () => {
    const stub = getStub("ack-lease-partial");
    const logId = new Uint8Array(16).fill(0x50).buffer;
    for (let i = 0; i < 3; i++) await stub.enqueue(logId, hash(0x10 + i));

    const batch = await pullBatch(stub, logId);
    expect((await stub.ackFirst(ackOf(batch, 0n, 14, 2))).acked).toBe(0);
    expect((await stub.stats()).pending).toBe(3);
    expect(await stub.resolveContent(hash(0x10))).toBeNull();
  });

  it("refuses an ack whose batch was re-pulled, without touching later rows", async () => {
    const stub = getStub("ack-lease-repulled");
    const logId = new Uint8Array(16).fill(0x51).buffer;
    await stub.enqueue(logId, hash(0x20));
    await stub.enqueue(logId, hash(0x21));

    // Poller A's lease is already expired, as if its commit outlasted it.
    const stale = await pullBatch(stub, logId, { visibilityMs: 0 });
    // Poller B re-pulls the same two rows.
    const fresh = await pullBatch(stub, logId);
    expect(fresh).toMatchObject({ seqLo: stale.seqLo, seqHi: stale.seqHi });

    // A acks while B holds the lease: refused.
    expect((await stub.ackFirst(ackOf(stale, 0n))).acked).toBe(0);
    // B's ack is the one that sequences the rows.
    expect((await stub.ackFirst(ackOf(fresh, 100n))).acked).toBe(2);

    // Later rows are pending; A acking again must not land on them.
    await stub.enqueue(logId, hash(0x22));
    await stub.enqueue(logId, hash(0x23));
    expect((await stub.ackFirst(ackOf(stale, 0n))).acked).toBe(0);

    expect(await stub.resolveContent(hash(0x20))).toEqual({ leafIndex: 100n });
    expect(await stub.resolveContent(hash(0x21))).toEqual({ leafIndex: 101n });
    expect(await stub.resolveContent(hash(0x22))).toBeNull();
    expect((await stub.stats()).pending).toBe(2);
  });

  it("accepts an ack after its lease expired if nothing re-pulled the rows", async () => {
    const stub = getStub("ack-lease-expired-unclaimed");
    const logId = new Uint8Array(16).fill(0x52).buffer;
    await stub.enqueue(logId, hash(0x30));

    const batch = await pullBatch(stub, logId, { visibilityMs: 0 });
    expect((await stub.ackFirst(ackOf(batch, 7n))).acked).toBe(1);
    expect(await stub.resolveContent(hash(0x30))).toEqual({ leafIndex: 7n });
  });

  it("does not dead-letter a batch that is still leased", async () => {
    const stub = getStub("ack-lease-deadletter");
    const logId = new Uint8Array(16).fill(0x53).buffer;
    await stub.enqueue(logId, hash(0x40));

    // Four expired attempts, then a fifth that is leased (attempts = 5).
    for (let i = 0; i < 4; i++) {
      await pullBatch(stub, logId, { visibilityMs: 0 });
    }
    const last = await pullBatch(stub, logId);
    // Another pull runs dead-lettering while the fifth attempt is in flight.
    expect(await pullBatches(stub)).toEqual([]);
    expect((await stub.stats()).deadLetters).toBe(0);

    expect((await stub.ackFirst(ackOf(last, 0n))).acked).toBe(1);
  });

  it("dead-letters a batch at max attempts once its lease has expired", async () => {
    const stub = getStub("ack-lease-deadletter-expired");
    const logId = new Uint8Array(16).fill(0x54).buffer;
    await stub.enqueue(logId, hash(0x41));

    for (let i = 0; i < 5; i++) {
      await pullBatch(stub, logId, { visibilityMs: 0 });
    }
    expect(await pullBatches(stub)).toEqual([]);
    expect((await stub.stats()).deadLetters).toBe(1);
  });
});

describe("SequencingQueue leases name one pull (FOR-655)", () => {
  // A log that poller A owns alone and poller B owns once both are active,
  // so the two pulls below both lease rows of it.
  function movingLog(): ArrayBuffer {
    for (let i = 0; i < 256; i++) {
      const logId = new Uint8Array(16).fill(i).buffer;
      if (
        assignLog(logId, ["A"]) === "A" &&
        assignLog(logId, ["A", "B"]) === "B"
      ) {
        return logId;
      }
    }
    throw new Error("no log moves from A to B");
  }

  it("gives same-millisecond pulls distinct leases and their own seq ranges", async () => {
    const ns = testEnv.SEQUENCING_QUEUE;
    const stub = ns.get(ns.idFromName("lease-same-ms"));
    const logId = movingLog();

    await runInDurableObject(stub, async (q: SequencingQueue, state) => {
      for (let i = 1; i <= 3; i++) await q.enqueue(logId, hash(0x60 + i));
      // Row 2 is on its last attempt.
      state.storage.sql.exec(
        "UPDATE queue_entries SET attempts = 4 WHERE seq = 2",
      );

      // No I/O between the pulls, so the DO clock does not advance.
      const a = await q.pull({ pollerId: "A", batchSize: 1, visibilityMs: 50 });
      const b = await q.pull({
        pollerId: "B",
        batchSize: 10,
        visibilityMs: 50,
      });
      expect(b.leaseExpiry).toBeGreaterThan(a.leaseExpiry);
      expect(a.logGroups.map((g) => [g.seqLo, g.seqHi])).toEqual([[1, 1]]);
      expect(b.logGroups.map((g) => [g.seqLo, g.seqHi])).toEqual([[2, 3]]);

      // A never acks. Both leases expire and row 2 is dead-lettered.
      await new Promise((r) => setTimeout(r, 120));
      (
        q as unknown as { movePoisonToDeadLetters(now: number): void }
      ).movePoisonToDeadLetters(Date.now());

      // B committed rows 2 and 3; with row 2 gone its ack must be refused,
      // and must not land on A's row 1.
      const bg = b.logGroups[0];
      const result = await q.ackFirst({
        logId,
        seqLo: bg.seqLo,
        seqHi: bg.seqHi,
        leaseExpiry: b.leaseExpiry,
        limit: bg.entries.length,
        firstLeafIndex: 100n,
        massifHeight: 14,
      });
      expect(result.acked).toBe(0);
      expect(await q.resolveContent(hash(0x61))).toBeNull();
      expect(await q.resolveContent(hash(0x63))).toBeNull();
    });
  });

  it("does not re-lease a row in its seq range that another pull holds", async () => {
    const ns = testEnv.SEQUENCING_QUEUE;
    const stub = ns.get(ns.idFromName("lease-only-returned-rows"));
    const logId = new Uint8Array(16).fill(0x70).buffer;
    const heldUntil = Date.now() + 60_000;

    await runInDurableObject(stub, async (q: SequencingQueue, state) => {
      for (let i = 1; i <= 3; i++) await q.enqueue(logId, hash(0x70 + i));
      // Row 2 is held by another pull's live lease.
      state.storage.sql.exec(
        "UPDATE queue_entries SET visible_after = ?, attempts = 1 WHERE seq = 2",
        heldUntil,
      );

      const pulled = await q.pull({
        pollerId: "A",
        batchSize: 10,
        visibilityMs: 30000,
      });
      expect(
        pulled.logGroups.map((g) => [g.seqLo, g.seqHi, g.entries.length]),
      ).toEqual([[1, 3, 2]]);

      const row2 = state.storage.sql
        .exec<{
          visible_after: number;
          attempts: number;
        }>("SELECT visible_after, attempts FROM queue_entries WHERE seq = 2")
        .toArray()[0];
      expect(row2).toEqual({ visible_after: heldUntil, attempts: 1 });
    });
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

    await stub.enqueue(logId, contentHash);
    await stub.ackFirst(ackOf(await pullBatch(stub, logId), 8192n, 14));

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
    // Above 64 the window overflows a number (Infinity near h=1026), so the
    // pre-write guard must reject it rather than let it through.
    expect(retainedEntryCount(64)).toBe(2 ** 65);
    expect(() => retainedEntryCount(65)).toThrow(RangeError);
    expect(() => retainedEntryCount(1030)).toThrow(RangeError);
  });

  it("retains four massifs of sequenced entries at 2^(h-1) leaves each", async () => {
    const stub = getStub("ack-first-retention-height");
    const logId = new Uint8Array(16).fill(0x49).buffer;
    const massifHeight = 3; // 4 leaves per massif -> retain 16 behind the max

    const hashes = Array.from(
      { length: 30 },
      (_, i) => new Uint8Array(32).fill(i).buffer,
    );
    for (const contentHash of hashes) {
      await stub.enqueue(logId, contentHash);
    }
    const batch = await pullBatch(stub, logId);
    expect(batch.count).toBe(30);
    await stub.ackFirst(ackOf(batch, 0n, massifHeight));

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
