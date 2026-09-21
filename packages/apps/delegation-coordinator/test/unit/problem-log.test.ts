/**
 * FOR-579: every problem response leaves one structured log line at the
 * worker edge (see `@canopy/problem-log`); successful responses leave none.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index.js";
import type { Env } from "../../src/env.js";

const typedEnv = env as unknown as Env;

describe("problem responses are logged (FOR-579)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("a 4xx problem response writes exactly one warn line and keeps its body", async () => {
    const response = await worker.fetch(
      new Request(
        "http://localhost/api/logs/e22c8d55-3f88-b2b5-f225-5d2c2441bcdd/no-such-route",
        { headers: { "cf-ray": "test-ray-2" } },
      ),
      typedEnv,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(405);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(warnSpy.mock.calls[0]![0]));
    expect(entry).toMatchObject({
      event: "problem_response",
      level: "warn",
      service: "delegation-coordinator",
      method: "GET",
      route: "/api/logs/{id}/no-such-route",
      status: 405,
      detail: "Method Not Allowed",
      ray: "test-ray-2",
    });

    expect(await response.text()).toBe("Method Not Allowed");
  });

  it("a successful response writes nothing", async () => {
    const response = await worker.fetch(
      new Request("http://localhost/_delegation-coordinator/health"),
      typedEnv,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
