import { encode } from "cbor-x";
import { SELF, fetchMock } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../../src/encoding.js";
import {
  hex32ToWireLogIdBytes,
  normalizeLogIdToHex32,
} from "../../src/log-id.js";
import { requestKeyFor } from "../../src/webhook/request-key.js";
import type { DelegationRequiredEvent } from "../../src/types/delegation-required-event.js";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";

const TEST_TOKEN = "test-coordinator-token";
const WEBHOOK_ORIGIN = "https://hooks.example.test";
const WEBHOOK_PATH = "/delegation-required";

function authHeaders(extra?: HeadersInit): HeadersInit {
  return {
    Authorization: `Bearer ${TEST_TOKEN}`,
    ...extra,
  };
}

function cborBody(value: unknown): Uint8Array {
  const encoded = encode(value);
  return encoded instanceof Uint8Array
    ? encoded
    : new Uint8Array(encoded as ArrayLike<number>);
}

function delegatedKey(seed: number): Uint8Array {
  const out = new Uint8Array(24);
  for (let i = 0; i < out.length; i++) out[i] = seed + i;
  return out;
}

async function registerWebhook(logUuid: string, url: string): Promise<void> {
  const res = await fetchWithDoRetry(
    `http://localhost/api/logs/${logUuid}/webhook`,
    {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ url }),
    },
  );
  expect(res.status).toBe(200);
}

async function postIssue(opts: {
  logHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
}): Promise<Response> {
  const body = cborBody({
    version: 1,
    logId: hex32ToWireLogIdBytes(opts.logHex32),
    mmrStart: opts.mmrStart,
    mmrEnd: opts.mmrEnd,
    algorithm: "ES256",
    delegatedPublicKey: opts.delegatedPublicKey,
    requestedTtlSeconds: 3600,
  });
  return fetchWithDoRetry("http://localhost/api/delegations", {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/cbor",
      Accept: "application/cbor",
    }),
    body,
  });
}

async function verifySignature(
  timestamp: string,
  rawBody: string,
  signatureB64Url: string,
): Promise<boolean> {
  const keyRes = await fetchWithDoRetry(
    "http://localhost/.well-known/forestrie-webhook-jwks.json",
  );
  expect(keyRes.status).toBe(200);
  const { keys } = (await keyRes.json()) as {
    keys: Array<JsonWebKey & { kid: string; alg: string }>;
  };
  const publicKeyJwk = keys[0]!;
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const sigBytes = Uint8Array.from(
    atob(signatureB64Url.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    sigBytes,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
}

describe("webhook delivery", () => {
  it("GET /.well-known/forestrie-webhook-jwks.json returns JWKS with ES256 key", async () => {
    const res = await fetchWithDoRetry(
      "http://localhost/.well-known/forestrie-webhook-jwks.json",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      keys: Array<{
        kid: string;
        alg: string;
        use: string;
        kty: string;
        crv: string;
        x: string;
        y: string;
      }>;
    };
    expect(body.keys).toHaveLength(1);
    const key = body.keys[0]!;
    expect(key.alg).toBe("ES256");
    expect(key.use).toBe("sig");
    expect(key.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(key.kty).toBe("EC");
    expect(key.crv).toBe("P-256");
    expect(key.x).toBeTruthy();
    expect(key.y).toBeTruthy();
  });

  it("pending miss with webhook registered emits delegation.required", async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    try {
      const logUuid = "51234567-89ab-cdef-0123-456789abcdef";
      const logHex32 = normalizeLogIdToHex32(logUuid);
      const key = delegatedKey(42);
      const webhookUrl = `${WEBHOOK_ORIGIN}${WEBHOOK_PATH}`;

      await registerWebhook(logUuid, webhookUrl);

      let receivedBody = "";
      let receivedTimestamp = "";
      let receivedSignature = "";
      fetchMock
        .get(WEBHOOK_ORIGIN)
        .intercept({ path: WEBHOOK_PATH, method: "POST" })
        .reply(
          200,
          (opts) => {
            receivedBody = opts.body as string;
            const headers = opts.headers as Record<string, string>;
            receivedTimestamp = headers["x-forestrie-webhook-timestamp"] ?? "";
            receivedSignature = headers["x-forestrie-webhook-signature"] ?? "";
            return "ok";
          },
          { headers: { "content-type": "text/plain" } },
        );

      const miss = await postIssue({
        logHex32,
        mmrStart: 1,
        mmrEnd: 8,
        delegatedPublicKey: key,
      });
      expect(miss.status).toBe(202);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const event = JSON.parse(receivedBody) as DelegationRequiredEvent;
      expect(event.type).toBe("delegation.required");
      expect(event.version).toBe(1);
      expect(event.logId).toBe(logHex32);
      expect(event.mmrStart).toBe(1);
      expect(event.mmrEnd).toBe(8);
      expect(event.delegatedPublicKey).toBe(bytesToBase64(key));
      expect(event.materialSubmitUrl).toBe(
        "http://localhost/api/delegations/material",
      );

      const pubkeyHash = await import("../../src/material-key.js").then((m) =>
        m.sha256Hex(key),
      );
      const expectedKey = await requestKeyFor(logHex32, 1, 8, pubkeyHash);
      expect(event.requestKey).toBe(expectedKey);

      expect(receivedTimestamp).toMatch(/^\d+$/);
      expect(receivedSignature).toBeTruthy();
      expect(
        await verifySignature(
          receivedTimestamp,
          receivedBody,
          receivedSignature,
        ),
      ).toBe(true);

      fetchMock.assertNoPendingInterceptors();
    } finally {
      fetchMock.deactivate();
    }
  });

  it("enabled=false suppresses webhook emit", async () => {
    const logUuid = "61234567-89ab-cdef-0123-456789abcdef";
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const webhookUrl = `${WEBHOOK_ORIGIN}${WEBHOOK_PATH}`;

    await registerWebhook(logUuid, webhookUrl);
    const disableRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/enabled`,
      {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(disableRes.status).toBe(200);

    const miss = await postIssue({
      logHex32,
      mmrStart: 2,
      mmrEnd: 9,
      delegatedPublicKey: delegatedKey(7),
    });
    expect(miss.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  it("no webhook url suppresses emit", async () => {
    const logUuid = "71234567-89ab-cdef-0123-456789abcdef";
    const logHex32 = normalizeLogIdToHex32(logUuid);

    const miss = await postIssue({
      logHex32,
      mmrStart: 3,
      mmrEnd: 10,
      delegatedPublicKey: delegatedKey(8),
    });
    expect(miss.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
});
