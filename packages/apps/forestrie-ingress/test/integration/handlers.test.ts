import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";

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

  // TODO: Add /queue/pull, /queue/ack, /queue/stats tests in Phase 4
});
