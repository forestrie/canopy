import { describe, expect, it } from "vitest";
import worker from "../../../src/index";
import type { ProblemDetails } from "@canopy/forestrie-ingress-types";
import { decodeAckResponse } from "../../../src/encoding";
import { testEnv, createRequest, createCborRequest, getStub } from "./fixture";

describe("/queue/ack", () => {
  it("POST with CBOR returns CBOR response", async () => {
    // First enqueue an entry via DO RPC
    const stub = getStub("global");
    const logId = new Uint8Array(16).fill(0xaa);
    const contentHash = new Uint8Array(32).fill(0xbb);
    const { seq } = await stub.enqueue(logId.buffer, contentHash.buffer);

    // Ack via HTTP with CBOR-encoded body using limit-based ack
    const request = createCborRequest("/queue/ack", "POST", {
      logId: logId,
      seqLo: seq,
      limit: 1,
      firstLeafIndex: 0,
      massifHeight: 14,
    });

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/cbor");

    const result = decodeAckResponse(await response.arrayBuffer());
    expect(result.acked).toBe(1);
  });

  it("returns 415 for JSON content type", async () => {
    const request = createRequest("/queue/ack", {
      method: "POST",
      body: {
        logId: "some-base64",
        seqLo: 1,
        limit: 1,
      },
      contentType: "application/json",
    });

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(415);
    expect(response.headers.get("Content-Type")).toBe(
      "application/problem+json",
    );

    const problem = (await response.json()) as ProblemDetails;
    expect(problem.detail).toContain("application/cbor");
  });

  it("returns 400 for missing logId", async () => {
    const request = createCborRequest("/queue/ack", "POST", {
      seqLo: 1,
      limit: 1,
    });

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toBe(
      "application/problem+json",
    );

    const problem = (await response.json()) as ProblemDetails;
    expect(problem.detail).toContain("logId");
  });

  it("returns 400 for negative limit", async () => {
    const request = createCborRequest("/queue/ack", "POST", {
      logId: new Uint8Array(16).fill(0xcc),
      seqLo: 10,
      limit: -5, // Invalid: negative limit
    });

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toBe(
      "application/problem+json",
    );

    const problem = (await response.json()) as ProblemDetails;
    expect(problem.type).toContain("invalid-request");
  });

  it("returns 400 for negative seqLo", async () => {
    const request = createCborRequest("/queue/ack", "POST", {
      logId: new Uint8Array(16).fill(0xdd),
      seqLo: -1,
      limit: 5,
    });

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    const problem = (await response.json()) as ProblemDetails;
    expect(problem.detail).toContain("seqLo");
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
