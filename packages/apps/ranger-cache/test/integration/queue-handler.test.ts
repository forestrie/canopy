import { describe, expect, it, vi } from "vitest";
import worker, { Env } from "../../src";

describe("ranger-cache queue handler", () => {
  it("processes R2_LEAVES notifications and writes to KV namespaces", async () => {
    const puts: string[] = [];

    const fakeKV = {
      get: vi.fn(),
      put: vi.fn(async (key: string, value: string) => {
        puts.push(`${key}=${value}`);
      }),
      delete: vi.fn(),
    };

    const env: Env = {
      R2_LEAVES: {
        // For this structural test we do not actually read from R2_LEAVES.
        get: vi.fn(),
      } as any,
      RANGER_MMR_INDEX: fakeKV as any,
      RANGER_MMR_MASSIFS: fakeKV as any,
      CANOPY_ID: "canopy-dev-1",
      FOREST_PROJECT_ID: "forest-dev-1",
      NODE_ENV: "test",
    };

    const batch = {
      messages: [
        {
          body: {
            bucket: "canopy-dev-1-leaves",
            key: "logs/log-123/massifs/42.cbor",
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

    expect(
      puts.some((entry) => entry.startsWith("logs/log-123/head=")),
    ).toBe(true);
    expect(
      puts.some((entry) =>
        entry.startsWith("logs/log-123/massifs/42="),
      ),
    ).toBe(true);
  });
});
