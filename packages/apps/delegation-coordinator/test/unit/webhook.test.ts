import { randomUUID } from "node:crypto";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { normalizeLogIdToHex32 } from "../../src/log-id.js";

const TEST_TOKEN = "test-coordinator-token";
const ISSUER_TOKEN = "per-log-issuer-token";

function authHeaders(
  token: string = TEST_TOKEN,
  extra?: HeadersInit,
): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  };
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

describe("webhook + enabled CRUD", () => {
  const logUuid = randomUUID();
  const logHex32 = normalizeLogIdToHex32(logUuid);
  const webhookUrl = "https://hooks.example.test/delegation";
  const webhookUrlUpdated = "https://hooks.example.test/delegation-v2";

  it("GET /webhook returns 404 before registration", async () => {
    const res = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/webhook`,
      { method: "GET", headers: authHeaders() },
    );
    expect(res.status).toBe(404);
  });

  it("PUT /webhook stores url and GET returns config", async () => {
    const putRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/webhook`,
      {
        method: "PUT",
        headers: authHeaders(TEST_TOKEN, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ url: webhookUrl }),
      },
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as {
      webhookUrl?: string;
      enabled: boolean;
    };
    expect(putBody.webhookUrl).toBe(webhookUrl);
    expect(putBody.enabled).toBe(true);

    const getRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/webhook`,
      { method: "GET", headers: authHeaders() },
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      webhookUrl?: string;
      enabled: boolean;
      createdAt: number;
      updatedAt: number;
    };
    expect(getBody.webhookUrl).toBe(webhookUrl);
    expect(getBody.enabled).toBe(true);
    expect(getBody.createdAt).toBeGreaterThan(0);
    expect(getBody.updatedAt).toBeGreaterThan(0);
  });

  it("PUT /webhook updates url", async () => {
    const putRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/webhook`,
      {
        method: "PUT",
        headers: authHeaders(TEST_TOKEN, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ url: webhookUrlUpdated }),
      },
    );
    expect(putRes.status).toBe(200);
    const body = (await putRes.json()) as { webhookUrl?: string };
    expect(body.webhookUrl).toBe(webhookUrlUpdated);
  });

  it("PUT /enabled false toggles kill switch", async () => {
    const putRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/enabled`,
      {
        method: "PUT",
        headers: authHeaders(TEST_TOKEN, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({ enabled: false });

    const getRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/enabled`,
      { method: "GET", headers: authHeaders() },
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ enabled: false });

    const webhookRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/webhook`,
      { method: "GET", headers: authHeaders() },
    );
    const webhookBody = (await webhookRes.json()) as { enabled: boolean };
    expect(webhookBody.enabled).toBe(false);
  });

  it("DELETE /webhook clears url but preserves enabled", async () => {
    const delRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/webhook`,
      { method: "DELETE", headers: authHeaders() },
    );
    expect(delRes.status).toBe(200);

    const getRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/webhook`,
      { method: "GET", headers: authHeaders() },
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as {
      webhookUrl?: string;
      enabled: boolean;
    };
    expect(body.webhookUrl).toBeUndefined();
    expect(body.enabled).toBe(false);

    const delAgain = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/webhook`,
      { method: "DELETE", headers: authHeaders() },
    );
    expect(delAgain.status).toBe(200);
  });

  it("rejects private webhook URLs", async () => {
    const res = await fetchWithDoRetry(
      `http://localhost/api/logs/${randomUUID()}/webhook`,
      {
        method: "PUT",
        headers: authHeaders(TEST_TOKEN, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ url: "https://10.0.0.1/hook" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("requires bearer auth on /webhook", async () => {
    const res = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/webhook`,
      { method: "GET" },
    );
    expect(res.status).toBe(401);
  });

  it("accepts per-log issuerToken on /webhook when signing route configured", async () => {
    const issuerLogUuid = randomUUID();
    const issuerLogHex = normalizeLogIdToHex32(issuerLogUuid);

    const routeRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${issuerLogUuid}/signing-route`,
      {
        method: "POST",
        headers: authHeaders(TEST_TOKEN, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          mode: "wallet",
          issuerToken: ISSUER_TOKEN,
        }),
      },
    );
    expect(routeRes.status).toBe(200);

    const putRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${issuerLogUuid}/webhook`,
      {
        method: "PUT",
        headers: authHeaders(ISSUER_TOKEN, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ url: webhookUrl }),
      },
    );
    expect(putRes.status).toBe(200);

    const enabledRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${issuerLogUuid}/enabled`,
      {
        method: "PUT",
        headers: authHeaders(ISSUER_TOKEN, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(enabledRes.status).toBe(401);

    void issuerLogHex;
  });

  it("PUT /enabled on a new log creates row with enabled default true", async () => {
    const freshUuid = randomUUID();
    const putRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${freshUuid}/enabled`,
      {
        method: "PUT",
        headers: authHeaders(TEST_TOKEN, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(putRes.status).toBe(200);

    const getRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${freshUuid}/enabled`,
      { method: "GET", headers: authHeaders() },
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ enabled: true });
  });

  void logHex32;
});
