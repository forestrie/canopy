import { describe, expect, it } from "vitest";
import worker from "../../../src/index";
import type { ProblemDetails } from "@canopy/forestrie-ingress-types";
import { testEnv, createRequest, getStub, toBase64 } from "./fixture";

describe("/queue/ack", () => {
  it("POST with base64 logId returns JSON response", async () => {
    // First enqueue an entry via DO RPC
    const stub = getStub("global");
    const logId = new Uint8Array(16).fill(0xaa);
    const contentHash = new Uint8Array(32).fill(0xbb);
    const { seq } = await stub.enqueue(logId.buffer, contentHash.buffer);

    // Ack via HTTP with base64-encoded logId
    const request = createRequest("/queue/ack", {
      method: "POST",
      body: {
        logId: toBase64(logId),
        fromSeq: seq,
        toSeq: seq,
      },
    });

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");

    const result = (await response.json()) as { deleted: number };
    expect(result.deleted).toBe(1);
  });

  it("returns 400 for missing logId", async () => {
    const request = createRequest("/queue/ack", {
      method: "POST",
      body: {
        fromSeq: 1,
        toSeq: 1,
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
    expect(problem.detail).toContain("logId");
  });

  it("returns 400 for invalid fromSeq/toSeq", async () => {
    const request = createRequest("/queue/ack", {
      method: "POST",
      body: {
        logId: toBase64(new Uint8Array(16).fill(0xcc)),
        fromSeq: 10,
        toSeq: 5, // Invalid: toSeq < fromSeq
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
  });

  it("returns 400 for negative fromSeq", async () => {
    const request = createRequest("/queue/ack", {
      method: "POST",
      body: {
        logId: toBase64(new Uint8Array(16).fill(0xdd)),
        fromSeq: -1,
        toSeq: 5,
      },
    });

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    const problem = (await response.json()) as ProblemDetails;
    expect(problem.detail).toContain("fromSeq");
  });

  it("GET returns 405 Method Not Allowed", async () => {
    const request = createRequest("/queue/ack");

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(405);
  });
});
