/**
 * API Tests for Canopy Native Workers Implementation
 *
 * These tests exercise the worker directly via Miniflare. For HTTP surface
 * coverage, see the Playwright suite under `packages/tests/canopy-api`.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("Canopy API", () => {
  it("should return health status", async () => {
    const request = new Request("http://localhost/api/health");
    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty("status", "healthy");
    expect(data).toHaveProperty("canopyId");
  });

  it("should return SCITT configuration", async () => {
    const request = new Request(
      "http://localhost/.well-known/scitt-configuration",
    );

    // const ctx = createExecutionContext();
    // const response = await worker.fetch(request, env, ctx);
    const response = await worker.fetch(request, env, {} as ExecutionContext);
    // Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
    //await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const config = await response.json();
    expect(config).toHaveProperty("serviceId");
    expect(config).toHaveProperty("scrapiVersion");
    expect(config).toHaveProperty("baseUrl");
  });

  it("should register a COSE statement", async () => {
    // Mock COSE Sign1 structure
    const mockCoseSign1 = new Uint8Array([
      0x84, // CBOR array of 4 elements
      0x40, // protected headers (empty bstr)
      0xa0, // unprotected headers (empty map)
      0x45,
      0x48,
      0x65,
      0x6c,
      0x6c,
      0x6f, // payload "Hello"
      0x40, // signature (empty bstr)
    ]);

    const request = new Request("http://localhost/logs/logid-1/entries", {
      method: "POST",
      headers: {
        "Content-Type": 'application/cose; cose-type="cose-sign1"',
      },
      body: mockCoseSign1,
    });

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    // Should accept the statement
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toMatch(
      /http:\/\/localhost\/logs\/logid-1\/entries\/[a-f0-9]{64}$/,
    );
  });

  it("debugging test - set breakpoint here", async () => {
    const testValue = "debug me"; // Set breakpoint on this line
    expect(testValue).toBe("debug me");
  });
});
