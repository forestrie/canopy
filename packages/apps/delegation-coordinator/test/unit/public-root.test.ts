import { randomUUID } from "node:crypto";
import { decode } from "cbor-x";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../../src/encoding.js";
import {
  hex32ToWireLogIdBytes,
  normalizeLogIdToHex32,
} from "../../src/log-id.js";
import type { TrustRootResponseCbor } from "../../src/types/trust-root-response.js";

const TEST_TOKEN = "test-coordinator-token";

function authHeaders(extra?: HeadersInit): HeadersInit {
  return {
    Authorization: `Bearer ${TEST_TOKEN}`,
    ...extra,
  };
}

function sampleXy(): { x: Uint8Array; y: Uint8Array } {
  const x = new Uint8Array(32);
  const y = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    x[i] = i + 1;
    y[i] = 255 - i;
  }
  return { x, y };
}

async function fetchWithDoRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await SELF.fetch(input, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("invalidating this Durable Object")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return SELF.fetch(input, init);
}

describe("GET /api/logs/{logId}/public-root", () => {
  it("POST then GET round-trips CBOR trust root with 16-byte logId", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const { x, y } = sampleXy();

    const postRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/public-root`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          alg: "ES256",
          x: bytesToBase64(x),
          y: bytesToBase64(y),
        }),
      },
    );
    expect(postRes.status).toBe(200);

    const getRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/public-root`,
      {
        method: "GET",
        headers: authHeaders({ Accept: "application/cbor" }),
      },
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("Content-Type")).toBe("application/cbor");

    const decoded = decode(
      new Uint8Array(await getRes.arrayBuffer()),
    ) as TrustRootResponseCbor;
    expect(decoded.alg).toBe("ES256");
    expect(decoded.x).toEqual(x);
    expect(decoded.y).toEqual(y);
    expect(decoded.logId).toEqual(hex32ToWireLogIdBytes(logHex32));
    expect(decoded.logId.byteLength).toBe(16);
  });

  it("GET before POST returns 404 application/problem+cbor", async () => {
    const missingLog = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const getRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${missingLog}/public-root`,
      {
        method: "GET",
        headers: authHeaders({ Accept: "application/cbor" }),
      },
    );
    expect(getRes.status).toBe(404);
    expect(getRes.headers.get("Content-Type")).toBe("application/problem+cbor");
  });

  it("second POST upserts and GET reflects new bytes", async () => {
    const logUuid = randomUUID();
    const first = sampleXy();
    const second = {
      x: new Uint8Array(32).fill(7),
      y: new Uint8Array(32).fill(8),
    };

    const postFirst = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/public-root`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          alg: "ES256",
          x: bytesToBase64(first.x),
          y: bytesToBase64(first.y),
        }),
      },
    );
    expect(postFirst.status).toBe(200);

    const postSecond = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/public-root`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          alg: "ES256",
          x: bytesToBase64(second.x),
          y: bytesToBase64(second.y),
        }),
      },
    );
    expect(postSecond.status).toBe(200);

    const getRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/public-root`,
      {
        method: "GET",
        headers: authHeaders({ Accept: "application/cbor" }),
      },
    );
    const decoded = decode(
      new Uint8Array(await getRes.arrayBuffer()),
    ) as TrustRootResponseCbor;
    expect(decoded.x).toEqual(second.x);
    expect(decoded.y).toEqual(second.y);
  });
});

describe("POST /api/logs/{logId}/public-root validation", () => {
  const logUuid = randomUUID();

  it("rejects alg other than ES256 with 400 problem+json", async () => {
    const { x, y } = sampleXy();
    const res = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/public-root`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          alg: "ES384",
          x: bytesToBase64(x),
          y: bytesToBase64(y),
        }),
      },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain(
      "application/problem+json",
    );
  });

  it("rejects x length other than 32 bytes with 400 problem+json", async () => {
    const shortX = new Uint8Array(16).fill(1);
    const y = new Uint8Array(32).fill(2);
    const res = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/public-root`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          alg: "ES256",
          x: bytesToBase64(shortX),
          y: bytesToBase64(y),
        }),
      },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain(
      "application/problem+json",
    );
  });
});
