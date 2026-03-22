/**
 * Bootstrap grant mint tests (Plan 0010, Plan 0011 §0).
 * POST /api/grants/bootstrap: optional body { rootLogId }, no server-side storage.
 * Plan 0011 §0: grantData must be bootstrap public key (64 bytes) for Univocity contract.
 */

import { decode as decodeCbor } from "cbor-x";
import { describe, expect, it, vi } from "vitest";
import { handlePostBootstrapGrant } from "../src/scrapi/bootstrap-grant";

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const ROOT_LOG_ID_64 =
  "550e8400e29b41d4a71644665544000000000000000000000000000000000000";

/** Fake 64-byte P-256 key (x||y) for grantData; same as used in mock. */
const MOCK_PUBKEY_X = "00".repeat(32);
const MOCK_PUBKEY_Y = "00".repeat(32);

function mockDelegationSignerAndPublicKey() {
  return vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u.includes("/api/public-key") && u.includes("bootstrap")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              x: `0x${MOCK_PUBKEY_X}`,
              y: `0x${MOCK_PUBKEY_Y}`,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
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
    mockDelegationSignerAndPublicKey();
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
      // Plan 0011 §0: grantData must be 64 bytes (bootstrap public key) for Univocity contract.
      const grantData = grantMap.get(6);
      expect(grantData).toBeDefined();
      expect(grantData!.length).toBe(64);
      const expectedGrantData = new Uint8Array(64);
      for (let i = 0; i < 32; i++) {
        expectedGrantData[i] = parseInt(
          MOCK_PUBKEY_X.slice(i * 2, i * 2 + 2),
          16,
        );
        expectedGrantData[32 + i] = parseInt(
          MOCK_PUBKEY_Y.slice(i * 2, i * 2 + 2),
          16,
        );
      }
      expect(Array.from(grantData!)).toEqual(Array.from(expectedGrantData));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns 201 with base64 when body has logId (alias)", async () => {
    mockDelegationSignerAndPublicKey();
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
    mockDelegationSignerAndPublicKey();
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

  it("returns 500 when alg is KS256 (grantData not implemented per Plan 0011 §0.5)", async () => {
    mockDelegationSignerAndPublicKey();
    try {
      const request = new Request("http://localhost/api/grants/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootLogId: UUID, alg: "KS256" }),
      });
      const response = await handlePostBootstrapGrant(request, {
        delegationSignerUrl: "https://signer.example",
        delegationSignerBearerToken: "token",
      });
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain("KS256");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
