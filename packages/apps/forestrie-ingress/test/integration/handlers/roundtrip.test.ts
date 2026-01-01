/**
 * HTTP round-trip integration tests.
 * Tests full cycle: enqueue (DO RPC) → pull (HTTP) → ack (HTTP)
 */

import { describe, expect, it } from "vitest";
import worker from "../../../src/index";
import { decodePullResponse, decodeAckResponse } from "../../../src/encoding";
import { testEnv, getStub, createCborRequest, DEFAULT_SHARD } from "./fixture";

describe("HTTP round-trip integration", () => {
  it("full cycle: enqueue → pull → ack → stats", async () => {
    const stub = getStub(DEFAULT_SHARD);
    const logId = new Uint8Array(16).fill(0xf1);
    const contentHash = new Uint8Array(32).fill(0xf2);

    // Enqueue entries via DO RPC
    const seq1 = await stub.enqueue(logId.buffer, contentHash.buffer);
    const seq2 = await stub.enqueue(logId.buffer, contentHash.buffer);
    expect(seq1.seq).toBeGreaterThan(0);
    expect(seq2.seq).toBe(seq1.seq + 1);

    // Pull via HTTP
    const pullRequest = createCborRequest("/queue/pull", "POST", {
      pollerId: "roundtrip-test-poller",
      batchSize: 100,
      visibilityMs: 30000,
    });

    const pullResponse = await worker.fetch(
      pullRequest,
      testEnv,
      {} as ExecutionContext,
    );

    expect(pullResponse.status).toBe(200);
    expect(pullResponse.headers.get("Content-Type")).toBe("application/cbor");

    const pullResult = decodePullResponse(await pullResponse.arrayBuffer());
    expect(pullResult.version).toBe(1);
    expect(pullResult.logGroups.length).toBeGreaterThan(0);

    // Find our log group
    const group = pullResult.logGroups.find(
      (g) => new Uint8Array(g.logId)[0] === 0xf1,
    );
    expect(group).toBeDefined();
    expect(group!.entries.length).toBe(2);

    // Ack via HTTP using limit-based ack (seqLo and entry count)
    const ackRequest = createCborRequest("/queue/ack", "POST", {
      logId: logId,
      seqLo: group!.seqLo,
      limit: group!.entries.length,
      firstLeafIndex: 0,
      massifHeight: 14,
    });

    const ackResponse = await worker.fetch(
      ackRequest,
      testEnv,
      {} as ExecutionContext,
    );

    expect(ackResponse.status).toBe(200);
    expect(ackResponse.headers.get("Content-Type")).toBe("application/cbor");

    const ackResult = decodeAckResponse(await ackResponse.arrayBuffer());
    expect(ackResult.acked).toBe(2);
  });

  it("visibility timeout redelivery via HTTP", async () => {
    const stub = getStub(DEFAULT_SHARD);
    const logId = new Uint8Array(16).fill(0xf3);
    const contentHash = new Uint8Array(32).fill(0xf4);

    // Enqueue an entry
    await stub.enqueue(logId.buffer, contentHash.buffer);

    // Pull with very short visibility (1ms)
    const pullRequest1 = createCborRequest("/queue/pull", "POST", {
      pollerId: "visibility-test-poller",
      batchSize: 100,
      visibilityMs: 1,
    });

    const pullResponse1 = await worker.fetch(
      pullRequest1,
      testEnv,
      {} as ExecutionContext,
    );
    expect(pullResponse1.status).toBe(200);

    const pullResult1 = decodePullResponse(await pullResponse1.arrayBuffer());
    const group1 = pullResult1.logGroups.find(
      (g) => new Uint8Array(g.logId)[0] === 0xf3,
    );
    expect(group1).toBeDefined();
    expect(group1!.entries.length).toBe(1);

    // Wait for visibility to expire
    await new Promise((r) => setTimeout(r, 10));

    // Pull again - should redeliver the entry
    const pullRequest2 = createCborRequest("/queue/pull", "POST", {
      pollerId: "visibility-test-poller",
      batchSize: 100,
      visibilityMs: 30000,
    });

    const pullResponse2 = await worker.fetch(
      pullRequest2,
      testEnv,
      {} as ExecutionContext,
    );
    expect(pullResponse2.status).toBe(200);

    const pullResult2 = decodePullResponse(await pullResponse2.arrayBuffer());
    const group2 = pullResult2.logGroups.find(
      (g) => new Uint8Array(g.logId)[0] === 0xf3,
    );
    expect(group2).toBeDefined();
    expect(group2!.entries.length).toBe(1);

    // Clean up: ack the entry
    const ackRequest = createCborRequest("/queue/ack", "POST", {
      logId: logId,
      seqLo: group2!.seqLo,
      limit: group2!.entries.length,
      firstLeafIndex: 0,
      massifHeight: 14,
    });
    await worker.fetch(ackRequest, testEnv, {} as ExecutionContext);
  });

  it("multiple pollers with log assignment via HTTP", async () => {
    const stub = getStub(DEFAULT_SHARD);
    const contentHash = new Uint8Array(32).fill(0xf5);

    // Enqueue entries for many logs
    const logIds: Uint8Array[] = [];
    for (let i = 0; i < 10; i++) {
      const logId = new Uint8Array(16);
      logId[0] = 0xf6;
      logId[1] = i;
      logIds.push(logId);
      await stub.enqueue(logId.buffer, contentHash.buffer);
    }

    // Poller A pulls
    const pullRequestA = createCborRequest("/queue/pull", "POST", {
      pollerId: "multi-poller-a",
      batchSize: 100,
      visibilityMs: 30000,
    });

    const pullResponseA = await worker.fetch(
      pullRequestA,
      testEnv,
      {} as ExecutionContext,
    );
    expect(pullResponseA.status).toBe(200);
    const pullResultA = decodePullResponse(await pullResponseA.arrayBuffer());

    // Poller B pulls
    const pullRequestB = createCborRequest("/queue/pull", "POST", {
      pollerId: "multi-poller-b",
      batchSize: 100,
      visibilityMs: 30000,
    });

    const pullResponseB = await worker.fetch(
      pullRequestB,
      testEnv,
      {} as ExecutionContext,
    );
    expect(pullResponseB.status).toBe(200);
    const pullResultB = decodePullResponse(await pullResponseB.arrayBuffer());

    // Filter to only our test logs (0xf6 prefix)
    const groupsA = pullResultA.logGroups.filter(
      (g) => new Uint8Array(g.logId)[0] === 0xf6,
    );
    const groupsB = pullResultB.logGroups.filter(
      (g) => new Uint8Array(g.logId)[0] === 0xf6,
    );

    // Both pollers should get some logs
    const totalGroups = groupsA.length + groupsB.length;
    expect(totalGroups).toBe(10);

    // No overlap - verify by checking second byte (our unique ID)
    const idsA = new Set(groupsA.map((g) => new Uint8Array(g.logId)[1]));
    const idsB = new Set(groupsB.map((g) => new Uint8Array(g.logId)[1]));

    for (const id of idsA) {
      expect(idsB.has(id)).toBe(false);
    }

    // Clean up: ack all entries using limit-based ack
    let leafIndex = 0;
    for (const group of [...groupsA, ...groupsB]) {
      const ackRequest = createCborRequest("/queue/ack", "POST", {
        logId: new Uint8Array(group.logId),
        seqLo: group.seqLo,
        limit: group.entries.length,
        firstLeafIndex: leafIndex,
        massifHeight: 14,
      });
      await worker.fetch(ackRequest, testEnv, {} as ExecutionContext);
      leafIndex += group.entries.length;
    }
  });
});
