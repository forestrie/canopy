import { describe, expect, it } from "vitest";
import worker from "../../../src/index";
import type { ProblemDetails } from "@canopy/forestrie-ingress-types";
import { decodeAckResponse } from "../../../src/encoding";
import {
  testEnv,
  createRequest,
  createCborRequest,
  getStub,
  DEFAULT_SHARD,
} from "./fixture";

describe("/queue/ack", () => {
  it("POST with CBOR returns CBOR response", async () => {
    // First enqueue an entry via DO RPC
    const stub = getStub(DEFAULT_SHARD);
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
    const request = createRequest("/queue/ack?shard=0", {
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

  it("returns 400 for a float massifHeight", async () => {
    // ranger sends a whole one-based height. The test encoder refuses
    // floats, so encode 14 and patch its value byte to the CBOR half float
    // 14.5 (f9 4b40). The handler's decoder yields a CborFloat, not a
    // number, so this is a client error before the DO, never a 500.
    const ok = createCborRequest("/queue/ack", "POST", {
      logId: new Uint8Array(16).fill(0xde),
      seqLo: 1,
      limit: 1,
      firstLeafIndex: 0,
      massifHeight: 14,
    });
    const bytes = new Uint8Array(await ok.arrayBuffer());
    const key = new TextEncoder().encode("massifHeight");
    const at = indexOfBytes(bytes, key) + key.length;
    expect(bytes[at]).toBe(14);
    const body = new Uint8Array(bytes.length + 2);
    body.set(bytes.subarray(0, at));
    body.set([0xf9, 0x4b, 0x40], at);
    body.set(bytes.subarray(at + 1), at + 3);
    const request = new Request(ok.url, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/cbor" },
    });

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    const problem = (await response.json()) as ProblemDetails;
    expect(problem.detail).toContain("massifHeight");
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

/** Returns the offset of needle in haystack, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
