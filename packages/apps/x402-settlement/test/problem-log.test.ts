/**
 * FOR-579: every problem response leaves one structured log line at the
 * worker edge (see `@canopy/problem-log`); successful responses leave none.
 */
import { env, createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";

const typedEnv = env as Env;

describe("problem responses are logged (FOR-579)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("a 401 on the ops gate writes exactly one warn line", async () => {
    const request = new Request("http://localhost/admin/reset-auth", {
      method: "POST",
      headers: { "cf-ray": "test-ray-3" },
      body: JSON.stringify({ authId: "local:0xabc" }),
    });
    const response = await worker.fetch(
      request,
      typedEnv,
      createExecutionContext(),
    );
    expect(response.status).toBe(401);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(warnSpy.mock.calls[0]![0]));
    expect(entry).toMatchObject({
      event: "problem_response",
      level: "warn",
      service: "x402-settlement",
      method: "POST",
      route: "/admin/reset-auth",
      status: 401,
      ray: "test-ray-3",
    });
  });
});
