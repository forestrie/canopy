import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi, beforeEach } from "vitest";
import worker from "../../src/index";
import type { RangerQueueBatch } from "../../src/rangerqueue";
import type { Env } from "../../src/env";

// Cast env to our Env type (it's provided by the test pool from wrangler.jsonc)
const testEnv = env as unknown as Env;

describe("ranger-cache queue handler", () => {
  it("handles health check endpoint", async () => {
    const request = new Request("http://localhost/_ranger-cache/health", {
      method: "GET",
    });

    const response = await worker.fetch(request, testEnv);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      canopyId: string;
    };
    expect(body.status).toBe("ok");
    expect(body.canopyId).toBe(testEnv.CANOPY_ID);
  });

  it("returns default response for unknown paths", async () => {
    const request = new Request("http://localhost/unknown", {
      method: "GET",
    });

    const response = await worker.fetch(request, testEnv);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe("ranger-cache worker");
  });

  // Note: Full queue handler integration tests require mock R2 with massif data
  // and are more complex to set up. The following tests verify the basic wiring.

  it("queue handler processes empty batch without error", async () => {
    const batch: RangerQueueBatch = {
      messages: [],
    };

    const ctx = createExecutionContext();
    await worker.queue(batch, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    // No error thrown = success
  });

  it("queue handler skips non-R2 notification messages", async () => {
    const batch: RangerQueueBatch = {
      messages: [
        {
          body: { foo: "bar" }, // Not an R2 notification
        },
      ],
    };

    const ctx = createExecutionContext();
    await worker.queue(batch, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    // Should log warning but not throw
  });

  it("queue handler skips non-PutObject actions", async () => {
    const batch: RangerQueueBatch = {
      messages: [
        {
          body: {
            account: "test-account",
            action: "DeleteObject", // Not PutObject
            bucket: "test-bucket",
            object: {
              key: "v2/merklelog/massifs/14/test-log-id/0000000000000000.log",
              size: 1000,
              eTag: "test-etag",
            },
            eventTime: "2024-01-01T00:00:00Z",
          },
        },
      ],
    };

    const ctx = createExecutionContext();
    await worker.queue(batch, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    // Should log skip message but not throw
  });
});
