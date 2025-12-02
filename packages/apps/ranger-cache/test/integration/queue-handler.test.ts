import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import worker, { Env } from "../../src";

describe("ranger-cache queue handler", () => {
  beforeEach(() => {
    // Mock fetch for REST API calls
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true }),
      json: async () => ({ success: true }),
    } as Response);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("processes R2_MMRS notifications and writes to KV namespaces", async () => {
    const fakeKV = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    // Create a fake massif blob large enough to pass size validation
    // Minimum required: 526624 bytes for height 14 massif
    const fakeMassifBlob = new ArrayBuffer(600000); // Slightly larger than minimum
    const fakeR2Object = {
      arrayBuffer: vi.fn().mockResolvedValue(fakeMassifBlob),
    };

    const env: Env = {
      R2_MMRS: {
        get: vi.fn().mockResolvedValue(fakeR2Object),
      } as any,
      RANGER_MMR_INDEX: fakeKV as any,
      RANGER_MMR_MASSIFS: fakeKV as any,
      CANOPY_ID: "canopy-dev-1",
      FOREST_PROJECT_ID: "forest-dev-1",
      NODE_ENV: "test",
      // Required for REST API bulk writes (fake values for testing)
      RANGER_CACHE_WRITER: "fake-api-token-for-testing",
      CLOUDFLARE_ACCOUNT_ID: "fake-account-id",
      RANGER_MMR_INDEX_NAMESPACE_ID: "fake-namespace-id",
    };

    const batch = {
      messages: [
        {
          body: {
            account: "68f25af297c4235c3f1c47b2f73925b0",
            action: "PutObject",
            bucket: "arbor-dev-1-logs",
            object: {
              key: "v2/merklelog/massifs/14/3062ea57-c184-41d8-bd61-296b02c680d8/0000000000000000.log",
              size: 600000,
              eTag: "test-etag",
            },
            eventTime: "2024-01-01T00:00:00Z",
          },
        },
      ],
    };

    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
    } as any;

    await (worker as any).queue(batch, env, ctx);
    await Promise.all(pending);

    // Verify that REST API was called for bulk write
    expect(global.fetch).toHaveBeenCalled();
    const fetchCall = vi.mocked(global.fetch).mock.calls[0];
    expect(fetchCall[0]).toContain(
      "/storage/kv/namespaces/fake-namespace-id/bulk",
    );
    expect(fetchCall[1]?.method).toBe("PUT");
    expect(fetchCall[1]?.headers).toMatchObject({
      Authorization: "Bearer fake-api-token-for-testing",
      "Content-Type": "application/json",
    });
  });
});
