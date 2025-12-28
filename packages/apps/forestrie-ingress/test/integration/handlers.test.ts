import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decode } from "cbor-x";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import type { QueueStats, ProblemDetails } from "@canopy/forestrie-ingress-types";

// Cast env to our Env type (it's provided by the test pool from wrangler.jsonc)
const testEnv = env as unknown as Env;

describe("forestrie-ingress worker handlers", () => {
  it("health endpoint returns 200", async () => {
    const request = new Request("http://localhost/_forestrie-ingress/health", {
      method: "GET",
    });

    const response = await worker.fetch(request, testEnv, {} as ExecutionContext);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; canopyId: string };
    expect(body.status).toBe("ok");
    expect(body.canopyId).toBe(testEnv.CANOPY_ID);
  });

  it("default response for unknown paths", async () => {
    const request = new Request("http://localhost/unknown", {
      method: "GET",
    });

    const response = await worker.fetch(request, testEnv, {} as ExecutionContext);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe("forestrie-ingress worker");
  });

  // Phase 4: HTTP endpoint tests
  describe("/queue/stats", () => {
    it("GET returns JSON stats", async () => {
      const request = new Request("http://localhost/queue/stats", {
        method: "GET",
      });

      const response = await worker.fetch(request, testEnv, {} as ExecutionContext);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("application/json");

      const stats = (await response.json()) as QueueStats;
      expect(stats).toHaveProperty("pending");
      expect(stats).toHaveProperty("deadLetters");
      expect(stats).toHaveProperty("activePollers");
      expect(stats).toHaveProperty("pollerLimitReached");
    });
  });

  describe("/queue/pull", () => {
    it("POST returns CBOR response", async () => {
      const request = new Request("http://localhost/queue/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pollerId: "http-test-poller",
          batchSize: 100,
          visibilityMs: 30000,
        }),
      });

      const response = await worker.fetch(request, testEnv, {} as ExecutionContext);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/cbor");

      // Decode CBOR response
      const buffer = await response.arrayBuffer();
      const decoded = decode(new Uint8Array(buffer)) as [number, number, unknown[]];

      // Verify positional array format: [version, leaseExpiry, logGroups]
      expect(decoded[0]).toBe(1); // version
      expect(decoded[1]).toBeGreaterThan(Date.now()); // leaseExpiry
      expect(Array.isArray(decoded[2])).toBe(true); // logGroups
    });

    it("returns 400 for missing pollerId", async () => {
      const request = new Request("http://localhost/queue/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchSize: 100,
          visibilityMs: 30000,
        }),
      });

      const response = await worker.fetch(request, testEnv, {} as ExecutionContext);

      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Type")).toBe("application/problem+json");

      const problem = (await response.json()) as ProblemDetails;
      expect(problem.type).toContain("invalid-request");
      expect(problem.detail).toContain("pollerId");
    });
  });

  describe("/queue/ack", () => {
    it("POST with base64 logId returns JSON response", async () => {
      // First enqueue an entry via DO RPC
      const stub = testEnv.SEQUENCING_QUEUE.get(
        testEnv.SEQUENCING_QUEUE.idFromName("global")
      );
      const logId = new Uint8Array(16).fill(0xaa);
      const contentHash = new Uint8Array(32).fill(0xbb);
      const { seq } = await stub.enqueue(logId.buffer, contentHash.buffer);

      // Ack via HTTP with base64-encoded logId
      const logIdBase64 = btoa(String.fromCharCode(...logId));
      const request = new Request("http://localhost/queue/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          logId: logIdBase64,
          fromSeq: seq,
          toSeq: seq,
        }),
      });

      const response = await worker.fetch(request, testEnv, {} as ExecutionContext);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("application/json");

      const result = (await response.json()) as { deleted: number };
      expect(result.deleted).toBe(1);
    });

    it("returns 400 for invalid fromSeq/toSeq", async () => {
      const logIdBase64 = btoa(String.fromCharCode(...new Uint8Array(16).fill(0xcc)));
      const request = new Request("http://localhost/queue/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          logId: logIdBase64,
          fromSeq: 10,
          toSeq: 5, // Invalid: toSeq < fromSeq
        }),
      });

      const response = await worker.fetch(request, testEnv, {} as ExecutionContext);

      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Type")).toBe("application/problem+json");

      const problem = (await response.json()) as ProblemDetails;
      expect(problem.type).toContain("invalid-request");
    });
  });

  describe("method not allowed", () => {
    it("GET /queue/pull returns 405", async () => {
      const request = new Request("http://localhost/queue/pull", {
        method: "GET",
      });

      const response = await worker.fetch(request, testEnv, {} as ExecutionContext);
      expect(response.status).toBe(405);
    });

    it("POST /queue/stats returns 405", async () => {
      const request = new Request("http://localhost/queue/stats", {
        method: "POST",
        body: "{}",
      });

      const response = await worker.fetch(request, testEnv, {} as ExecutionContext);
      expect(response.status).toBe(405);
    });
  });
});

describe("forestrie-ingress DO integration", () => {
  function getStub(name: string) {
    return testEnv.SEQUENCING_QUEUE.get(
      testEnv.SEQUENCING_QUEUE.idFromName(name)
    );
  }

  it("enqueue → stats → ack round-trip", async () => {
    const stub = getStub("integration-roundtrip-test");
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

    // Ack first two entries
    const ackResult = await stub.ackRange(logId, 1, 2);
    expect(ackResult.deleted).toBe(2);

    // Verify one entry remains
    stats = await stub.stats();
    expect(stats.pending).toBe(1);

    // Ack the last entry
    const ackResult2 = await stub.ackRange(logId, 3, 3);
    expect(ackResult2.deleted).toBe(1);

    // Queue should be empty
    stats = await stub.stats();
    expect(stats.pending).toBe(0);
    expect(stats.oldestEntryAgeMs).toBeNull();
  });

  it("multiple logIds are isolated", async () => {
    const stub = getStub("integration-isolation-test");
    const logId1 = new Uint8Array(16).fill(0xc1).buffer;
    const logId2 = new Uint8Array(16).fill(0xc2).buffer;
    const contentHash = new Uint8Array(32).fill(0xd3).buffer;

    // Enqueue to both logs
    await stub.enqueue(logId1, contentHash);
    await stub.enqueue(logId1, contentHash);
    await stub.enqueue(logId2, contentHash);
    await stub.enqueue(logId2, contentHash);
    await stub.enqueue(logId2, contentHash);

    let stats = await stub.stats();
    expect(stats.pending).toBe(5);

    // Ack all of logId1
    const result1 = await stub.ackRange(logId1, 1, 2);
    expect(result1.deleted).toBe(2);

    stats = await stub.stats();
    expect(stats.pending).toBe(3);

    // Ack all of logId2
    const result2 = await stub.ackRange(logId2, 3, 5);
    expect(result2.deleted).toBe(3);

    stats = await stub.stats();
    expect(stats.pending).toBe(0);
  });

  // Phase 3: pull with grouped response integration test
  it("enqueue → pull returns grouped response with correct structure", async () => {
    const stub = getStub("integration-pull-grouped-test");
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
      (g) => new Uint8Array(g.logId)[0] === 0xe1
    );
    const group2 = response.logGroups.find(
      (g) => new Uint8Array(g.logId)[0] === 0xe2
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
      new Uint8Array(16).fill(0x11)
    );
    expect(group1!.entries[1].extra0).toBeNull();

    // Now ack all entries using seqLo/seqHi from response
    await stub.ackRange(logId1, group1!.seqLo, group1!.seqHi);
    await stub.ackRange(logId2, group2!.seqLo, group2!.seqHi);

    // Queue should be empty
    const stats = await stub.stats();
    expect(stats.pending).toBe(0);
  });
});
