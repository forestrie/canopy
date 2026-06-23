/**
 * Webhook registration CRUD on delegation-coordinator (FOR-92).
 *
 * Requires DELEGATION_COORDINATOR_URL and COORDINATOR_APP_TOKEN.
 */

import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import {
  assertCoordinatorApiE2eEnv,
  hasCoordinatorApiE2eEnv,
} from "@e2e-utils/coordinator-api-env.js";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  if (!hasCoordinatorApiE2eEnv()) {
    throw new Error(
      "Coordinator webhook e2e requires DELEGATION_COORDINATOR_URL and COORDINATOR_APP_TOKEN.",
    );
  }
});

test.describe("coordinator webhook CRUD", () => {
  const { baseUrl: coordinatorUrl, appToken } = assertCoordinatorApiE2eEnv();
  const logId = randomUUID();
  const webhookUrl = "https://hooks.example.test/delegation";
  const webhookUrlUpdated = "https://hooks.example.test/delegation-v2";

  function authHeaders(extra?: Record<string, string>) {
    return {
      Authorization: `Bearer ${appToken}`,
      ...extra,
    };
  }

  test("PUT then GET registers webhook config", async ({ request }) => {
    const putRes = await request.put(
      `${coordinatorUrl}/api/logs/${logId}/webhook`,
      {
        headers: authHeaders({ "Content-Type": "application/json" }),
        data: { url: webhookUrl },
      },
    );
    expect(putRes.status()).toBe(200);
    const putBody = (await putRes.json()) as {
      webhookUrl?: string;
      enabled: boolean;
    };
    expect(putBody.webhookUrl).toBe(webhookUrl);
    expect(putBody.enabled).toBe(true);

    const getRes = await request.get(
      `${coordinatorUrl}/api/logs/${logId}/webhook`,
      { headers: authHeaders() },
    );
    expect(getRes.status()).toBe(200);
    const getBody = (await getRes.json()) as {
      webhookUrl?: string;
      enabled: boolean;
      createdAt: number;
      updatedAt: number;
    };
    expect(getBody.webhookUrl).toBe(webhookUrl);
    expect(getBody.enabled).toBe(true);
    expect(getBody.createdAt).toBeGreaterThan(0);
  });

  test("PUT updates webhook url", async ({ request }) => {
    const putRes = await request.put(
      `${coordinatorUrl}/api/logs/${logId}/webhook`,
      {
        headers: authHeaders({ "Content-Type": "application/json" }),
        data: { url: webhookUrlUpdated },
      },
    );
    expect(putRes.status()).toBe(200);
    const body = (await putRes.json()) as { webhookUrl?: string };
    expect(body.webhookUrl).toBe(webhookUrlUpdated);
  });

  test("PUT /enabled toggles kill switch", async ({ request }) => {
    const putRes = await request.put(
      `${coordinatorUrl}/admin/api/logs/${logId}/enabled`,
      {
        headers: authHeaders({ "Content-Type": "application/json" }),
        data: { enabled: false },
      },
    );
    expect(putRes.status()).toBe(200);
    expect(await putRes.json()).toEqual({
      enabled: false,
      userEnabled: true,
      operatorEnabled: false,
    });

    const getRes = await request.get(
      `${coordinatorUrl}/admin/api/logs/${logId}/enabled`,
      { headers: authHeaders() },
    );
    expect(getRes.status()).toBe(200);
    expect(await getRes.json()).toEqual({
      enabled: false,
      userEnabled: true,
      operatorEnabled: false,
    });
  });

  test("DELETE /webhook clears url", async ({ request }) => {
    const delRes = await request.delete(
      `${coordinatorUrl}/api/logs/${logId}/webhook`,
      { headers: authHeaders() },
    );
    expect(delRes.status()).toBe(200);

    const getRes = await request.get(
      `${coordinatorUrl}/api/logs/${logId}/webhook`,
      { headers: authHeaders() },
    );
    expect(getRes.status()).toBe(200);
    const body = (await getRes.json()) as {
      webhookUrl?: string;
      enabled: boolean;
    };
    expect(body.webhookUrl).toBeUndefined();
    expect(body.enabled).toBe(false);
  });

  test("re-enable via PUT /enabled", async ({ request }) => {
    const putRes = await request.put(
      `${coordinatorUrl}/admin/api/logs/${logId}/enabled`,
      {
        headers: authHeaders({ "Content-Type": "application/json" }),
        data: { enabled: true },
      },
    );
    expect(putRes.status()).toBe(200);
    expect(await putRes.json()).toEqual({
      enabled: true,
      userEnabled: true,
      operatorEnabled: true,
    });
  });
});
