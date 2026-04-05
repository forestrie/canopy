/**
 * Register-grant endpoint tests (Plan 0001 Step 6, Plan 0005, Plan 0014).
 * Auth: Authorization: Forestrie-Grant <base64> (Custodian COSE profile).
 */

import { encodeGrantRequest } from "@canopy/encoding";
import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import { uuidToBytes } from "../src/grant";
import type { Grant } from "../src/grant";
import { forestrieGrantAuthorizationHeader } from "./helpers/custodian-transparent-grant";

const testEnv = env as unknown as Env;

const TEST_KID = new Uint8Array(16).fill(0xcd);

let testPriv: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  testPriv = pair.privateKey;
});

async function transparentStatementHeader(grant: Grant): Promise<string> {
  return forestrieGrantAuthorizationHeader(grant, testPriv, TEST_KID);
}

describe("POST /register/{bootstrap}/grants and POST /register/{bootstrap}/entries", () => {
  const logId = "550e8400-e29b-41d4-a716-446655440000";
  /** Bootstrap segment for URLs (may equal logId for tests). */
  const boot = logId;

  it("returns 503 when grant sequencing not configured", async () => {
    const authGrant: Grant = {
      logId: uuidToBytes(logId),
      ownerLogId: uuidToBytes("660e8400-e29b-41d4-a716-446655440001"),
      grant: new Uint8Array(8),
      maxHeight: 0,
      minGrowth: 0,
      grantData: new Uint8Array([]),
    };

    const bodyBytes = encodeGrantRequest({
      logId: uuidToBytes(logId),
      ownerLogId: uuidToBytes("660e8400-e29b-41d4-a716-446655440001"),
      grant: new Uint8Array(8),
      grantData: new Uint8Array([]),
    });

    const request = new Request(`http://localhost/register/${boot}/grants`, {
      method: "POST",
      headers: {
        "Content-Type": "application/cbor",
        Authorization: await transparentStatementHeader(authGrant),
      },
      body: bodyBytes,
    });

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    const responseBytes = new Uint8Array(await response.arrayBuffer());
    const decoded = decodeCbor(responseBytes) as { detail?: string };
    expect(decoded.detail).toContain("Grant sequencing not configured");
  });

  it("returns 404 for POST /logs/{logId}/grants", async () => {
    const request = new Request(`http://localhost/logs/${logId}/grants`, {
      method: "POST",
    });
    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(404);
  });

  it("returns 405 for POST /logs/{bootstrap}/{logId}/entries/{hash}", async () => {
    const contentHash = "ab".repeat(32);
    const request = new Request(
      `http://localhost/logs/${boot}/${logId}/entries/${contentHash}`,
      {
        method: "POST",
      },
    );
    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(405);
  });

  it("returns 404 for POST /logs/grants (use /register/grants)", async () => {
    const request = new Request(`http://localhost/logs/grants`, {
      method: "POST",
    });
    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 for POST /logs/entries (use /register/entries)", async () => {
    const request = new Request(`http://localhost/logs/entries`, {
      method: "POST",
    });
    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(404);
  });

  it("returns 401 without Authorization: Forestrie-Grant for POST /register/{bootstrap}/entries", async () => {
    const request = new Request(`http://localhost/register/${boot}/entries`, {
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

  it("returns 401 without Authorization: Forestrie-Grant for POST /register/{bootstrap}/grants", async () => {
    const bodyBytes = encodeGrantRequest({
      logId: uuidToBytes(logId),
      ownerLogId: uuidToBytes("660e8400-e29b-41d4-a716-446655440001"),
      grant: new Uint8Array(8),
      grantData: new Uint8Array([]),
    });
    const request = new Request(`http://localhost/register/${boot}/grants`, {
      method: "POST",
      headers: { "Content-Type": "application/cbor" },
      body: bodyBytes,
    });
    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(401);
  });
});
