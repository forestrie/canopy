/**
 * Bootstrap grant mint tests (Plan 0010).
 * POST /api/grants/bootstrap: optional body { rootLogId }, no server-side storage.
 */

import { decode as decodeCbor } from "cbor-x";
import { describe, expect, it, vi } from "vitest";
import { handlePostBootstrapGrant } from "../src/scrapi/bootstrap-grant";

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const ROOT_LOG_ID_64 =
  "550e8400e29b41d4a71644665544000000000000000000000000000000000000";

function mockDelegationSigner() {
  return vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u.includes("/api/delegate/bootstrap")) {
        return Promise.resolve(
          new Response(JSON.stringify({ signature: "00".repeat(64) }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${u}`));
    }),
  );
}

describe("handlePostBootstrapGrant", () => {
  it("returns 201 with base64 body when body has rootLogId (UUID)", async () => {
    const stub = mockDelegationSigner();
    try {
      const request = new Request("http://localhost/api/grants/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootLogId: UUID }),
      });
      const response = await handlePostBootstrapGrant(request, {
        delegationSignerUrl: "https://signer.example",
        delegationSignerBearerToken: "token",
      });
      expect(response.status).toBe(201);
      const body = await response.text();
      expect(body).toMatch(/^[A-Za-z0-9+/]+=*$/);
      const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
      const cose = decodeCbor(bytes) as unknown[];
      expect(cose).toHaveLength(4);
      const payload = cose[2] as Uint8Array;
      expect(payload).toBeDefined();
      const grantMap = decodeCbor(payload) as Map<number, Uint8Array>;
      const logIdBytes = grantMap.get(1);
      expect(logIdBytes).toBeDefined();
      expect(logIdBytes!.length).toBe(32);
      const last16 = Array.from(logIdBytes!.slice(-16))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const expectedHex = UUID.replace(/-/g, "");
      expect(last16).toBe(expectedHex);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns 201 with base64 when body has logId (alias)", async () => {
    const stub = mockDelegationSigner();
    try {
      const request = new Request("http://localhost/api/grants/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logId: UUID }),
      });
      const response = await handlePostBootstrapGrant(request, {
        delegationSignerUrl: "https://signer.example",
        delegationSignerBearerToken: "token",
      });
      expect(response.status).toBe(201);
      const body = await response.text();
      expect(body.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns 500 when no rootLogId in body and env.rootLogId missing", async () => {
    const request = new Request("http://localhost/api/grants/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const response = await handlePostBootstrapGrant(request, {
      delegationSignerUrl: "https://signer.example",
      delegationSignerBearerToken: "token",
    });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("ROOT_LOG_ID not configured");
  });

  it("uses env.rootLogId when body is empty", async () => {
    const stub = mockDelegationSigner();
    try {
      const request = new Request("http://localhost/api/grants/bootstrap", {
        method: "POST",
      });
      const response = await handlePostBootstrapGrant(request, {
        rootLogId: ROOT_LOG_ID_64,
        delegationSignerUrl: "https://signer.example",
        delegationSignerBearerToken: "token",
      });
      expect(response.status).toBe(201);
      const body = await response.text();
      expect(body).toMatch(/^[A-Za-z0-9+/]+=*$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns 400 for invalid rootLogId in body", async () => {
    const request = new Request("http://localhost/api/grants/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootLogId: "not-a-valid-id" }),
    });
    const response = await handlePostBootstrapGrant(request, {
      delegationSignerUrl: "https://signer.example",
      delegationSignerBearerToken: "token",
    });
    expect(response.status).toBe(400);
  });
});
