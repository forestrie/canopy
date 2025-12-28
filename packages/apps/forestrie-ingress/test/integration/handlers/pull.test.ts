import { describe, expect, it } from "vitest";
import { decode } from "cbor-x";
import worker from "../../../src/index";
import type { ProblemDetails } from "@canopy/forestrie-ingress-types";
import { testEnv, createRequest } from "./fixture";

describe("/queue/pull", () => {
  it("POST returns CBOR response", async () => {
    const request = createRequest("/queue/pull", {
      method: "POST",
      body: {
        pollerId: "http-test-poller",
        batchSize: 100,
        visibilityMs: 30000,
      },
    });

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/cbor");

    // Decode CBOR response
    const buffer = await response.arrayBuffer();
    const decoded = decode(new Uint8Array(buffer)) as [
      number,
      number,
      unknown[],
    ];

    // Verify positional array format: [version, leaseExpiry, logGroups]
    expect(decoded[0]).toBe(1); // version
    expect(decoded[1]).toBeGreaterThan(Date.now()); // leaseExpiry
    expect(Array.isArray(decoded[2])).toBe(true); // logGroups
  });

  it("returns 400 for missing pollerId", async () => {
    const request = createRequest("/queue/pull", {
      method: "POST",
      body: {
        batchSize: 100,
        visibilityMs: 30000,
      },
    });

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toBe("application/problem+json");

    const problem = (await response.json()) as ProblemDetails;
    expect(problem.type).toContain("invalid-request");
    expect(problem.detail).toContain("pollerId");
  });

  it("returns 400 for invalid batchSize", async () => {
    const request = createRequest("/queue/pull", {
      method: "POST",
      body: {
        pollerId: "test-poller",
        batchSize: -1,
        visibilityMs: 30000,
      },
    });

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    const problem = (await response.json()) as ProblemDetails;
    expect(problem.detail).toContain("batchSize");
  });

  it("GET returns 405 Method Not Allowed", async () => {
    const request = createRequest("/queue/pull");

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(405);
  });
});
