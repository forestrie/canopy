/**
 * Worker-level and DO integration tests.
 * HTTP handler tests are in handlers/ directory.
 */

import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { testEnv, getStubByName, createRequest } from "./handlers/fixture";
import { ackOf, batchFor, pullBatch, pullBatches } from "../pulledbatch";

describe("forestrie-ingress worker", () => {
  it("health endpoint returns 200", async () => {
    const request = createRequest("/_forestrie-ingress/health");

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      canopyId: string;
    };
    expect(body.status).toBe("ok");
    expect(body.canopyId).toBe(testEnv.CANOPY_ID);
  });

  it("default response for unknown paths", async () => {
    const request = createRequest("/unknown");

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe("forestrie-ingress worker");
  });
});

describe("forestrie-ingress DO integration", () => {
  it("enqueue → stats → ack round-trip", async () => {
    const stub = getStubByName("integration-roundtrip-test");
    const logId = new Uint8Array(16).fill(0xa1).buffer;
    const contentHash = new Uint8Array(32).fill(0xb2).buffer;

    // Start with empty queue
    let stats = await stub.stats();
    expect(stats.pending).toBe(0);

    // Enqueue several entries
    const seq1 = await stub.enqueue(logId, contentHash);
    const seq2 = await stub.enqueue(logId, contentHash);
    const seq3 = await stub.enqueue(logId, contentHash);

    expect(seq1.seq).toBe(1);
    expect(seq2.seq).toBe(2);
    expect(seq3.seq).toBe(3);

    // Verify pending count
    stats = await stub.stats();
    expect(stats.pending).toBe(3);
    expect(stats.oldestEntryAgeMs).toBeGreaterThanOrEqual(0);

    // Pull and ack the first two entries
    // (firstLeafIndex=0, massifHeight=14 for test)
    const first = await pullBatch(stub, logId, { batchSize: 2 });
    const ackResult = await stub.ackFirst(ackOf(first, 0n));
    expect(ackResult.acked).toBe(2);

    // Verify one entry remains
    stats = await stub.stats();
    expect(stats.pending).toBe(1);

    // Pull and ack the last entry
    const last = await pullBatch(stub, logId);
    expect(last).toMatchObject({ seqLo: seq3.seq, seqHi: seq3.seq });
    const ackResult2 = await stub.ackFirst(ackOf(last, 2n));
    expect(ackResult2.acked).toBe(1);

    // Queue should be empty
    stats = await stub.stats();
    expect(stats.pending).toBe(0);
    expect(stats.oldestEntryAgeMs).toBeNull();
  });

  it("multiple logIds are isolated", async () => {
    const stub = getStubByName("integration-isolation-test");
    const logId1 = new Uint8Array(16).fill(0xc1).buffer;
    const logId2 = new Uint8Array(16).fill(0xc2).buffer;
    const contentHash = new Uint8Array(32).fill(0xd3).buffer;

    // Enqueue to both logs (interleaved to create non-contiguous seq per log)
    await stub.enqueue(logId1, contentHash); // seq 1
    await stub.enqueue(logId1, contentHash); // seq 2
    await stub.enqueue(logId2, contentHash); // seq 3
    await stub.enqueue(logId2, contentHash); // seq 4
    await stub.enqueue(logId2, contentHash); // seq 5

    let stats = await stub.stats();
    expect(stats.pending).toBe(5);

    const batches = await pullBatches(stub);

    // Ack all of logId1 (2 entries)
    const result1 = await stub.ackFirst(ackOf(batchFor(batches, logId1), 0n));
    expect(result1.acked).toBe(2);

    stats = await stub.stats();
    expect(stats.pending).toBe(3);

    // Ack all of logId2 (3 entries, seq 3..5)
    const batch2 = batchFor(batches, logId2);
    expect(batch2).toMatchObject({ seqLo: 3, seqHi: 5, count: 3 });
    const result2 = await stub.ackFirst(ackOf(batch2, 2n));
    expect(result2.acked).toBe(3);

    stats = await stub.stats();
    expect(stats.pending).toBe(0);
  });

  // Phase 3: pull with grouped response integration test
  it("enqueue → pull returns grouped response with correct structure", async () => {
    const stub = getStubByName("integration-pull-grouped-test");
    const logId1 = new Uint8Array(16).fill(0xe1).buffer;
    const logId2 = new Uint8Array(16).fill(0xe2).buffer;
    const contentHash1 = new Uint8Array(32).fill(0xf1).buffer;
    const contentHash2 = new Uint8Array(32).fill(0xf2).buffer;
    const extra0 = new Uint8Array(16).fill(0x11).buffer;

    // Enqueue entries to two different logs
    await stub.enqueue(logId1, contentHash1, { extra0 });
    await stub.enqueue(logId1, contentHash1);
    await stub.enqueue(logId2, contentHash2);
    await stub.enqueue(logId1, contentHash1);
    await stub.enqueue(logId2, contentHash2);

    // Single poller pulls all entries
    const response = await stub.pull({
      pollerId: "integration-poller",
      batchSize: 100,
      visibilityMs: 30000,
    });

    // Verify response structure
    expect(response.version).toBe(1);
    expect(response.leaseExpiry).toBeGreaterThan(Date.now());
    expect(response.logGroups.length).toBe(2);

    // Find groups by logId
    const group1 = response.logGroups.find(
      (g) => new Uint8Array(g.logId)[0] === 0xe1,
    );
    const group2 = response.logGroups.find(
      (g) => new Uint8Array(g.logId)[0] === 0xe2,
    );

    expect(group1).toBeDefined();
    expect(group2).toBeDefined();

    // logId1 has entries at seq 1, 2, 4 (3 entries)
    expect(group1!.entries.length).toBe(3);
    expect(group1!.seqLo).toBe(1);
    expect(group1!.seqHi).toBe(4);

    // logId2 has entries at seq 3, 5 (2 entries)
    expect(group2!.entries.length).toBe(2);
    expect(group2!.seqLo).toBe(3);
    expect(group2!.seqHi).toBe(5);

    // Verify extras preserved
    expect(new Uint8Array(group1!.entries[0].extra0!)).toEqual(
      new Uint8Array(16).fill(0x11),
    );
    expect(group1!.entries[1].extra0).toBeNull();

    // Now ack each group under the pull's lease
    for (const [group, first] of [
      [group1!, 0n],
      [group2!, 3n],
    ] as const) {
      await stub.ackFirst({
        logId: group.logId,
        seqLo: group.seqLo,
        seqHi: group.seqHi,
        leaseExpiry: response.leaseExpiry,
        limit: group.entries.length,
        firstLeafIndex: first,
        massifHeight: 14,
      });
    }

    // Queue should be empty
    const stats = await stub.stats();
    expect(stats.pending).toBe(0);
  });
});
