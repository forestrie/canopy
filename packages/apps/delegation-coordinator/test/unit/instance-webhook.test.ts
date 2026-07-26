/**
 * Instance-level webhooks, inherited by copy (ADR-0005 amendment, FOR-468).
 *
 * The properties under test are the ones the ADR settles: a log bound to an
 * instance gets the instance's URL written into its **own** row, a re-point
 * fans that copy out again, an explicit per-log URL survives a re-point, and
 * having no webhook at all stays a supported configuration rather than an
 * error.
 */

import { randomUUID } from "node:crypto";
import { encodeCborDeterministic } from "@forestrie/encoding";
import { fetchMock } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../../src/encoding.js";
import {
  hex32ToWireLogIdBytes,
  normalizeLogIdToHex32,
} from "../../src/log-id.js";
import type { DelegationRequiredEvent } from "../../src/types/delegation-required-event.js";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";

const TEST_TOKEN = "test-coordinator-token";

function authHeaders(
  token: string = TEST_TOKEN,
  extra?: HeadersInit,
): HeadersInit {
  return { Authorization: `Bearer ${token}`, ...extra };
}

function jsonAuthHeaders(token: string = TEST_TOKEN): HeadersInit {
  return authHeaders(token, { "Content-Type": "application/json" });
}

interface WebhookConfigBody {
  webhookUrl?: string;
  instanceKey?: string;
  inherited?: boolean;
  enabled: boolean;
}

interface InstanceWebhookBody {
  instanceKey: string;
  webhookUrl?: string;
  memberLogs?: number;
  updatedLogs?: number;
  shards?: number;
}

/** A fresh instance key per test, so shard state never leaks between them. */
function freshInstanceKey(): string {
  return `eip155:11155111:${randomUUID().replace(/-/g, "")}`;
}

async function putInstanceWebhook(
  instanceKey: string,
  url: string,
): Promise<Response> {
  return fetchWithDoRetry(
    `http://localhost/api/instances/${encodeURIComponent(instanceKey)}/webhook`,
    {
      method: "PUT",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ url }),
    },
  );
}

async function bindLogToInstance(
  logUuid: string,
  instanceKey: string,
): Promise<Response> {
  return fetchWithDoRetry(`http://localhost/api/logs/${logUuid}/webhook`, {
    method: "PUT",
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ instanceKey }),
  });
}

async function getLogWebhook(logUuid: string): Promise<WebhookConfigBody> {
  const res = await fetchWithDoRetry(
    `http://localhost/api/logs/${logUuid}/webhook`,
    { method: "GET", headers: authHeaders() },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as WebhookConfigBody;
}

describe("instance webhook inheritance by copy", () => {
  it("copies an existing instance webhook into a log at registration", async () => {
    const instanceKey = freshInstanceKey();
    const instanceUrl = "https://hooks.example.test/instance-a";
    const putRes = await putInstanceWebhook(instanceKey, instanceUrl);
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as InstanceWebhookBody;
    expect(putBody.webhookUrl).toBe(instanceUrl);
    expect(putBody.shards).toBeGreaterThan(1);

    const logUuid = randomUUID();
    const bindRes = await bindLogToInstance(logUuid, instanceKey);
    expect(bindRes.status).toBe(200);
    const bindBody = (await bindRes.json()) as WebhookConfigBody;
    expect(bindBody.webhookUrl).toBe(instanceUrl);
    expect(bindBody.instanceKey).toBe(instanceKey);
    expect(bindBody.inherited).toBe(true);

    const readBack = await getLogWebhook(logUuid);
    expect(readBack.webhookUrl).toBe(instanceUrl);
    expect(readBack.inherited).toBe(true);
  });

  it("binds a log before the instance has a webhook, then fills it on re-point", async () => {
    const instanceKey = freshInstanceKey();
    const logUuid = randomUUID();

    // Absence is a supported configuration: binding with no instance webhook
    // yet must succeed and leave the log with no URL.
    const bindRes = await bindLogToInstance(logUuid, instanceKey);
    expect(bindRes.status).toBe(200);
    const bindBody = (await bindRes.json()) as WebhookConfigBody;
    expect(bindBody.webhookUrl).toBeUndefined();
    expect(bindBody.instanceKey).toBe(instanceKey);

    const url = "https://hooks.example.test/instance-late";
    const res = await putInstanceWebhook(instanceKey, url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InstanceWebhookBody;
    expect(body.updatedLogs).toBe(1);
    expect(body.memberLogs).toBe(1);

    expect((await getLogWebhook(logUuid)).webhookUrl).toBe(url);
  });

  it("re-points every member log, across shards, in one operation", async () => {
    const instanceKey = freshInstanceKey();
    const firstUrl = "https://hooks.example.test/instance-v1";
    const secondUrl = "https://hooks.example.test/instance-v2";
    expect((await putInstanceWebhook(instanceKey, firstUrl)).status).toBe(200);

    // Enough logs that they cannot all land in the same shard (shard count 4).
    const logUuids = Array.from({ length: 12 }, () => randomUUID());
    for (const logUuid of logUuids) {
      expect((await bindLogToInstance(logUuid, instanceKey)).status).toBe(200);
    }
    for (const logUuid of logUuids) {
      expect((await getLogWebhook(logUuid)).webhookUrl).toBe(firstUrl);
    }

    const repoint = await putInstanceWebhook(instanceKey, secondUrl);
    expect(repoint.status).toBe(200);
    const repointBody = (await repoint.json()) as InstanceWebhookBody;
    expect(repointBody.updatedLogs).toBe(logUuids.length);
    expect(repointBody.memberLogs).toBe(logUuids.length);

    for (const logUuid of logUuids) {
      expect((await getLogWebhook(logUuid)).webhookUrl).toBe(secondUrl);
    }
  });

  it("leaves an explicit per-log webhook untouched when the instance re-points", async () => {
    const instanceKey = freshInstanceKey();
    expect(
      (await putInstanceWebhook(instanceKey, "https://hooks.example.test/inst"))
        .status,
    ).toBe(200);

    const inheritedLog = randomUUID();
    expect((await bindLogToInstance(inheritedLog, instanceKey)).status).toBe(
      200,
    );

    const overriddenLog = randomUUID();
    const ownUrl = "https://hooks.example.test/log-specific";
    const overrideRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${overriddenLog}/webhook`,
      {
        method: "PUT",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ url: ownUrl, instanceKey }),
      },
    );
    expect(overrideRes.status).toBe(200);
    const overrideBody = (await overrideRes.json()) as WebhookConfigBody;
    expect(overrideBody.webhookUrl).toBe(ownUrl);
    expect(overrideBody.instanceKey).toBe(instanceKey);
    expect(overrideBody.inherited).toBeUndefined();

    const repoint = await putInstanceWebhook(
      instanceKey,
      "https://hooks.example.test/inst-moved",
    );
    const repointBody = (await repoint.json()) as InstanceWebhookBody;
    expect(repointBody.updatedLogs).toBe(1);
    expect(repointBody.memberLogs).toBe(2);

    expect((await getLogWebhook(inheritedLog)).webhookUrl).toBe(
      "https://hooks.example.test/inst-moved",
    );
    expect((await getLogWebhook(overriddenLog)).webhookUrl).toBe(ownUrl);
  });

  it("DELETE drops the instance webhook and the copies it placed", async () => {
    const instanceKey = freshInstanceKey();
    expect(
      (await putInstanceWebhook(instanceKey, "https://hooks.example.test/gone"))
        .status,
    ).toBe(200);
    const logUuid = randomUUID();
    expect((await bindLogToInstance(logUuid, instanceKey)).status).toBe(200);

    const delRes = await fetchWithDoRetry(
      `http://localhost/api/instances/${encodeURIComponent(instanceKey)}/webhook`,
      { method: "DELETE", headers: authHeaders() },
    );
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as InstanceWebhookBody;
    expect(delBody.updatedLogs).toBe(1);

    // Reverts to "no webhook" — pre-emptive supply only, not an error.
    const after = await getLogWebhook(logUuid);
    expect(after.webhookUrl).toBeUndefined();
    expect(after.instanceKey).toBe(instanceKey);
  });

  it("GET aggregates member logs across shards and 404s for an unknown instance", async () => {
    const instanceKey = freshInstanceKey();
    const missing = await fetchWithDoRetry(
      `http://localhost/api/instances/${encodeURIComponent(instanceKey)}/webhook`,
      { method: "GET", headers: authHeaders() },
    );
    expect(missing.status).toBe(404);

    const url = "https://hooks.example.test/instance-get";
    expect((await putInstanceWebhook(instanceKey, url)).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await bindLogToInstance(randomUUID(), instanceKey)).status).toBe(
        200,
      );
    }

    const res = await fetchWithDoRetry(
      `http://localhost/api/instances/${encodeURIComponent(instanceKey)}/webhook`,
      { method: "GET", headers: authHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as InstanceWebhookBody;
    expect(body.webhookUrl).toBe(url);
    expect(body.memberLogs).toBe(5);
  });

  it("delivers delegation.required to an inherited instance webhook", async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    try {
      const instanceKey = freshInstanceKey();
      const origin = "https://instance-hooks.example.test";
      const path = "/delegation-required";
      expect(
        (await putInstanceWebhook(instanceKey, `${origin}${path}`)).status,
      ).toBe(200);

      const logUuid = randomUUID();
      const logHex32 = normalizeLogIdToHex32(logUuid);
      expect((await bindLogToInstance(logUuid, instanceKey)).status).toBe(200);

      let receivedBody = "";
      fetchMock
        .get(origin)
        .intercept({ path, method: "POST" })
        .reply(
          200,
          (opts) => {
            receivedBody = opts.body as string;
            return "ok";
          },
          { headers: { "content-type": "text/plain" } },
        );

      const delegatedPublicKey = new Uint8Array(24).fill(7);
      const miss = await fetchWithDoRetry("http://localhost/api/delegations", {
        method: "POST",
        headers: authHeaders(TEST_TOKEN, {
          "Content-Type": "application/cbor",
          Accept: "application/cbor",
        }),
        body: encodeCborDeterministic({
          version: 1,
          logId: hex32ToWireLogIdBytes(logHex32),
          mmrStart: 1,
          mmrEnd: 8,
          algorithm: "ES256",
          delegatedPublicKey,
          requestedTtlSeconds: 3600,
        }),
      });
      expect(miss.status).toBe(202);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // The event already identifies the log, which is what makes one endpoint
      // serving many logs workable — no payload change was needed.
      const event = JSON.parse(receivedBody) as DelegationRequiredEvent;
      expect(event.type).toBe("delegation.required");
      expect(event.logId).toBe(logHex32);
      expect(event.delegatedPublicKey).toBe(bytesToBase64(delegatedPublicKey));
    } finally {
      fetchMock.assertNoPendingInterceptors();
      fetchMock.deactivate();
    }
  });
});

describe("instance webhook validation and auth", () => {
  it("requires the coordinator app token", async () => {
    const res = await fetchWithDoRetry(
      `http://localhost/api/instances/${encodeURIComponent(freshInstanceKey())}/webhook`,
      { method: "GET" },
    );
    expect(res.status).toBe(401);
  });

  it("rejects a private instance webhook URL", async () => {
    const res = await putInstanceWebhook(
      freshInstanceKey(),
      "https://10.0.0.1/hook",
    );
    expect(res.status).toBe(400);
  });

  it("rejects a malformed instance key", async () => {
    const res = await fetchWithDoRetry(
      `http://localhost/api/instances/${encodeURIComponent("bad key!")}/webhook`,
      {
        method: "PUT",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ url: "https://hooks.example.test/x" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("rejects a log webhook PUT carrying neither url nor instanceKey", async () => {
    const res = await fetchWithDoRetry(
      `http://localhost/api/logs/${randomUUID()}/webhook`,
      {
        method: "PUT",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
  });

  it("normalizes instance key case on both write and read", async () => {
    const instanceKey = freshInstanceKey();
    const url = "https://hooks.example.test/case";
    expect(
      (await putInstanceWebhook(instanceKey.toUpperCase(), url)).status,
    ).toBe(200);

    const logUuid = randomUUID();
    expect(
      (await bindLogToInstance(logUuid, instanceKey.toUpperCase())).status,
    ).toBe(200);
    const body = await getLogWebhook(logUuid);
    expect(body.instanceKey).toBe(instanceKey);
    expect(body.webhookUrl).toBe(url);
  });
});
