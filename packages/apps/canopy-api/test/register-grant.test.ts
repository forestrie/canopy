/**
 * Register-grant endpoint tests (Plan 0001 Step 6).
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import { decodeGrant, kindBytesToSegment, KIND_ATTESTOR, uuidToBytes } from "../src/grant";

const testEnv = env as unknown as Env;

describe("POST /logs/{logId}/grants", () => {
  const logId = "550e8400-e29b-41d4-a716-446655440000";

  it("returns 201 and stores grant at content-addressable path", async () => {
    const body = {
      logId: uuidToBytes(logId),
      ownerLogId: uuidToBytes("660e8400-e29b-41d4-a716-446655440001"),
      grantFlags: new Uint8Array(8),
      grantData: new Uint8Array([]),
      signer: new Uint8Array([0x01, 0x02, 0x03]),
      kind: new Uint8Array([KIND_ATTESTOR]),
    };
    const bodyBytes = encodeCbor(body);

    const request = new Request(`http://localhost/logs/${logId}/grants`, {
      method: "POST",
      headers: { "Content-Type": "application/cbor" },
      body: bodyBytes,
    });

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(201);
    const location = response.headers.get("Location");
    expect(location).not.toBeNull();
    expect(location).toMatch(/^\/attestor\/[0-9a-f]{64}\.cbor$/);

    const key = location!.slice(1);
    const obj = await testEnv.R2_GRANTS.get(key);
    expect(obj).not.toBeNull();
    const stored = new Uint8Array(await obj!.arrayBuffer());
    const decoded = decodeGrant(stored);
    expect(new Uint8Array(decoded.logId)).toEqual(body.logId);
    expect(kindBytesToSegment(decoded.kind)).toBe("attestor");
    expect(new Uint8Array(decoded.signer)).toEqual(new Uint8Array(body.signer));
  });

  it("returns 401 without grant location for entries", async () => {
    const request = new Request(`http://localhost/logs/${logId}/entries`, {
      method: "POST",
      headers: { "Content-Type": "application/cbor" },
      body: encodeCbor({ signedStatement: new Uint8Array(100) }),
    });
    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(401);
  });

  it("returns 415 for non-CBOR content type at grants", async () => {
    const request = new Request(`http://localhost/logs/${logId}/grants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(415);
  });
});
