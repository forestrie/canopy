/**
 * Register-grant endpoint tests (Plan 0001 Step 6, Plan 0005).
 * Auth: Authorization: Forestrie-Grant <base64> (transparent statement only).
 * Request body: grant wire format (go-univocity keys 0–8) for the grant being created.
 */

import { encodeGrantRequest } from "@canopy/encoding";
import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import {
  encodeGrantPayload,
  KIND_ATTESTOR,
  uuidToBytes,
} from "../src/grant";
import type { Grant } from "../src/grant";

const testEnv = env as unknown as Env;

const PROTECTED_EMPTY = new Uint8Array([0xa0]);
const IDTIMESTAMP_ZEROS = new Uint8Array(8);
const HEADER_IDTIMESTAMP = -65537;

/** Build transparent statement (COSE Sign1) for Authorization: Forestrie-Grant. */
function transparentStatementHeader(grant: Grant): string {
  const payloadBytes = encodeGrantPayload(grant);
  const unprotected = new Map<number, Uint8Array>([
    [HEADER_IDTIMESTAMP, IDTIMESTAMP_ZEROS],
  ]);
  const signature = new Uint8Array(64);
  const coseSign1 = [
    PROTECTED_EMPTY,
    unprotected,
    payloadBytes,
    signature,
  ];
  const bytes = new Uint8Array(encodeCbor(coseSign1));
  const base64 = btoa(String.fromCharCode(...bytes));
  return `Forestrie-Grant ${base64}`;
}

describe("POST /logs/{logId}/grants", () => {
  const logId = "550e8400-e29b-41d4-a716-446655440000";

  it("returns 503 when grant sequencing not configured (no SEQUENCING_QUEUE)", async () => {
    // testEnv omits SEQUENCING_QUEUE (see test/env.d.ts); register-grant requires it.
    const authGrant: Grant = {
      version: 1,
      idtimestamp: new Uint8Array(8),
      logId: uuidToBytes(logId),
      ownerLogId: uuidToBytes("660e8400-e29b-41d4-a716-446655440001"),
      grantFlags: new Uint8Array(8),
      maxHeight: 0,
      minGrowth: 0,
      grantData: new Uint8Array([]),
      signer: new Uint8Array([0x01, 0x02, 0x03]),
      kind: new Uint8Array([KIND_ATTESTOR]),
    };

    const bodyBytes = encodeGrantRequest({
      logId: uuidToBytes(logId),
      ownerLogId: uuidToBytes("660e8400-e29b-41d4-a716-446655440001"),
      grantFlags: new Uint8Array(8),
      grantData: new Uint8Array([]),
      signer: new Uint8Array([0x01, 0x02, 0x03]),
      kind: new Uint8Array([KIND_ATTESTOR]),
    });

    const request = new Request(`http://localhost/logs/${logId}/grants`, {
      method: "POST",
      headers: {
        "Content-Type": "application/cbor",
        Authorization: transparentStatementHeader(authGrant),
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

  it("returns 401 without Authorization: Forestrie-Grant", async () => {
    const bodyBytes = encodeGrantRequest({
      logId: uuidToBytes(logId),
      ownerLogId: uuidToBytes("660e8400-e29b-41d4-a716-446655440001"),
      grantFlags: new Uint8Array(8),
      grantData: new Uint8Array([]),
      signer: new Uint8Array(32),
      kind: new Uint8Array([KIND_ATTESTOR]),
    });
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
    expect(response.status).toBe(401);
  });
});
