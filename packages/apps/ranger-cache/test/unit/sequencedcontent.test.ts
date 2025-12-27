import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";
import type { Env } from "../../src/env";

// Cast env to our Env type (it's provided by the test pool from wrangler.jsonc)
const testEnv = env as unknown as Env;

// The DO is available via env.SEQUENCED_CONTENT when wrangler.jsonc is configured
describe("SequencedContent Durable Object", () => {
  // Helper to get a fresh DO stub with a unique name per test
  function getStub(testName: string) {
    const id = testEnv.SEQUENCED_CONTENT.idFromName(`test-log/${testName}`);
    return testEnv.SEQUENCED_CONTENT.get(id);
  }

  it("resolveContent returns null for unknown content hash", async () => {
    const stub = getStub("resolve-unknown");
    const result = await stub.resolveContent(12345n);
    expect(result).toBeNull();
  });

  // Note: Full batchUpsertFromMassif tests require constructing valid massif blobs
  // with proper headers and leaf table structure. These are better suited for
  // integration tests with real massif data.
  //
  // The DO's internal logic (leaf enumeration, MMR index calculation, eviction)
  // is tested indirectly through the integration tests in queuehandler.test.ts

  // Skipped: Cloudflare vitest-pool-workers has a known limitation with isolated
  // storage cleanup when DO methods throw errors via RPC. The validation works
  // correctly at runtime but cannot be tested in this environment.
  // See: https://github.com/cloudflare/workers-sdk/issues/5605
  it.skip("batchUpsertFromMassif rejects massifHeight of 0", async () => {
    const stub = getStub("invalid-height-0");
    const emptyBuffer = new ArrayBuffer(0);

    let error: Error | undefined;
    try {
      await stub.batchUpsertFromMassif(emptyBuffer, 0, 0);
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toMatch(/massifHeight/);
  });

  it.skip("batchUpsertFromMassif rejects massifHeight of 65", async () => {
    const stub = getStub("invalid-height-65");
    const emptyBuffer = new ArrayBuffer(0);

    let error: Error | undefined;
    try {
      await stub.batchUpsertFromMassif(emptyBuffer, 65, 0);
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toMatch(/massifHeight/);
  });
});
