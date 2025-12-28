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
});
