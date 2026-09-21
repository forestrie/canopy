/**
 * FOR-579: every problem response leaves one structured log line at the
 * worker edge (see `@canopy/problem-log`); successful responses leave none.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeCborDeterministic } from "@forestrie/encoding";
import worker from "../src/index";
import type { Env } from "../src/index";

const testEnv = env as unknown as Env;

describe("problem responses are logged (FOR-579)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("a 4xx problem response writes exactly one warn line and keeps its body", async () => {
    const request = new Request(
      "http://localhost/no/such/route/0123456789abcdef0123456789abcdef",
      { headers: { "cf-ray": "test-ray-1" } },
    );
    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(404);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(warnSpy.mock.calls[0]![0]));
    expect(entry).toMatchObject({
      event: "problem_response",
      level: "warn",
      service: "canopy-api",
      method: "GET",
      path: "/no/such/route/0123456789abcdef0123456789abcdef",
      route: "/no/such/route/{id}",
      status: 404,
      title: "Not Found",
      ray: "test-ray-1",
    });
    // canopy-api's 404 passes its message as the problem `type` (third
    // positional argument of `problemResponse`), so that is where it lands.
    expect(entry.type).toContain("was not found");

    // The client still receives the problem body.
    const body = decodeCborDeterministic(
      new Uint8Array(await response.arrayBuffer()),
    ) as Map<string, unknown>;
    expect(body.get("status")).toBe(404);
    expect(body.get("title")).toBe("Not Found");
  });

  it("a successful response writes nothing", async () => {
    const response = await worker.fetch(
      new Request("http://localhost/api/health"),
      testEnv,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
