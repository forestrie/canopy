import { describe, expect, it } from "vitest";

import { handleAdminResetStorage } from "../../src/handlers/admin-reset-storage.js";
import type { Env } from "../../src/env.js";

const TOKEN = "test-reset-token-0123456789abcdef";

function makeEnv(overrides: Partial<Env>): Env {
  return {
    NODE_ENV: "dev",
    COORDINATOR_RESET_TOKEN: TOKEN,
    ...overrides,
  } as Env;
}

function makeRequest(token?: string): { request: Request; url: URL } {
  const url = new URL("https://coordinator.test/admin/reset-storage?shard=all");
  const headers = new Headers();
  if (token !== undefined) {
    headers.set("X-Forestrie-Coordinator-Reset", token);
  }
  return { request: new Request(url, { method: "POST", headers }), url };
}

describe("handleAdminResetStorage environment gating", () => {
  it("hides the endpoint on non-dev workers by default", async () => {
    const { request, url } = makeRequest(TOKEN);
    const res = await handleAdminResetStorage(
      request,
      url,
      makeEnv({ NODE_ENV: "prod" }),
    );
    expect(res.status).toBe(404);
  });

  it("allows non-dev workers that opt in with COORDINATOR_RESET_ALLOWED", async () => {
    // Dev-forest prod lanes opt in for content-reset; still token-gated, so a
    // bad token must yield 401 (not 404) once the flag is set.
    const { request, url } = makeRequest("wrong-token");
    const res = await handleAdminResetStorage(
      request,
      url,
      makeEnv({ NODE_ENV: "prod", COORDINATOR_RESET_ALLOWED: "1" }),
    );
    expect(res.status).toBe(401);
  });

  it("still requires the token to be configured when opted in", async () => {
    const { request, url } = makeRequest(TOKEN);
    const res = await handleAdminResetStorage(
      request,
      url,
      makeEnv({
        NODE_ENV: "prod",
        COORDINATOR_RESET_ALLOWED: "1",
        COORDINATOR_RESET_TOKEN: undefined,
      }),
    );
    expect(res.status).toBe(503);
  });

  it("rejects a bad token on dev workers", async () => {
    const { request, url } = makeRequest("wrong-token");
    const res = await handleAdminResetStorage(request, url, makeEnv({}));
    expect(res.status).toBe(401);
  });
});
