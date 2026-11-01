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

/**
 * firstLeafIndex is a uint64 on the wire: arbor's ranger sends it as CBOR
 * major type 0 (pinned by `ackGoldenUint64MaxHex` in arbor
 * services/ranger/src/consumer/ingress/ack_test.go; change both together).
 */
describe("/queue/ack uint64 firstLeafIndex", () => {
  const GOLDEN_LOG_ID = Uint8Array.from({ length: 16 }, (_, i) => 0x10 + i);
  const GOLDEN_PREFIX =
    "a5" +
    "656c696d697401" + // "limit": 1
    "656c6f6749645010" +
    "1112131415161718191a1b1c1d1e1f" + // "logId"
    "657365714c6f01" + // "seqLo": 1
    "6c6d6173736966486569676874" +
    "1821" + // "massifHeight": 33
    "6e66697273744c656166496e646578"; // "firstLeafIndex"
  // arbor ranger golden: firstLeafIndex 2^64-1, massifHeight 33 (the lowest
  // height whose massifs, 2^32 leaves each, can reach 2^64-1).
  const GOLDEN_HEX = GOLDEN_PREFIX + "1bffffffffffffffff";

  function rawCborAck(hex: string): Request {
    const bytes = Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
    return new Request(`http://localhost/queue/ack?shard=${DEFAULT_SHARD}`, {
      method: "POST",
      body: bytes,
      headers: { "Content-Type": "application/cbor" },
    });
  }

  async function post(request: Request): Promise<Response> {
    return worker.fetch(request, testEnv, {} as ExecutionContext);
  }

  it("accepts the ranger's golden ack at 2^64-1 and records it exactly", async () => {
    const stub = getStub(DEFAULT_SHARD);
    const contentHash = new Uint8Array(32).fill(0x7a);
    const { seq } = await stub.enqueue(
      GOLDEN_LOG_ID.buffer,
      contentHash.buffer,
    );
    expect(seq).toBe(1); // the golden body acks seqLo 1

    const response = await post(rawCborAck(GOLDEN_HEX));
    expect(response.status).toBe(200);
    expect(decodeAckResponse(await response.arrayBuffer()).acked).toBe(1);

    const UINT64_MAX = (1n << 64n) - 1n;
    // Massif (2^64-1) / 2^32 = MAX_MASSIF_INDEX: the last writable massif.
    expect(await stub.resolveContent(contentHash.buffer)).toEqual({
      leafIndex: UINT64_MAX,
    });
  });

  it("accepts 2^53+1 encoded by the canopy CBOR encoder", async () => {
    const stub = getStub(DEFAULT_SHARD);
    const logId = new Uint8Array(16).fill(0x7b);
    const contentHash = new Uint8Array(32).fill(0x7b);
    const { seq } = await stub.enqueue(logId.buffer, contentHash.buffer);

    const response = await post(
      createCborRequest("/queue/ack", "POST", {
        logId,
        seqLo: seq,
        limit: 1,
        firstLeafIndex: (1n << 53n) + 1n,
        massifHeight: 24,
      }),
    );
    expect(response.status).toBe(200);
    expect(await stub.resolveContent(contentHash.buffer)).toEqual({
      leafIndex: (1n << 53n) + 1n,
    });
  });

  it.each([
    ["a float", "f93e00"], // 1.5, shortest (half) form
    ["a negative integer", "20"], // -1
    ["a text string", "6131"], // "1"
  ])("rejects firstLeafIndex as %s with 400", async (_, valueHex) => {
    const response = await post(rawCborAck(GOLDEN_PREFIX + valueHex));
    expect(response.status).toBe(400);
    const problem = (await response.json()) as ProblemDetails;
    expect(problem.detail).toContain("firstLeafIndex");
  });

  // A massif of one-based height h holds 2^(h-1) leaves, so the last leaf
  // Go can write is 2^(31+h) - 1. h=32 pins the convention: with 2^h leaves
  // per massif it would be accepted.
  it.each([
    ["h=14: massif 2^51 - 1", 14],
    ["h=32: massif 2^33 - 1", 32],
  ])(
    "rejects 2^64-1 when its massif exceeds MAX_MASSIF_INDEX (%s)",
    async (_, h) => {
      const response = await post(
        createCborRequest("/queue/ack", "POST", {
          logId: new Uint8Array(16).fill(0x7c),
          seqLo: 1,
          limit: 1,
          firstLeafIndex: (1n << 64n) - 1n,
          massifHeight: h,
        }),
      );
      expect(response.status).toBe(400);
      const problem = (await response.json()) as ProblemDetails;
      expect(problem.detail).toContain("massif index");
    },
  );
});

describe("/queue/ack batch bounds", () => {
  it("rejects a batch that runs past 2^64-1", async () => {
    const response = await worker.fetch(
      createCborRequest("/queue/ack", "POST", {
        logId: new Uint8Array(16).fill(0x7d),
        seqLo: 1,
        limit: 2,
        firstLeafIndex: (1n << 64n) - 1n,
        massifHeight: 40,
      }),
      testEnv,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(400);
  });
});
