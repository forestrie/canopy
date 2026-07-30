import { randomUUID } from "node:crypto";
import { encodeCborDeterministic } from "@forestrie/encoding";
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
import { testDelegatedCoseKey } from "./byok-material-fixture.js";
import { delegateKeyEntryWithVoucher } from "./registrar-voucher-fixture.js";
import {
  mintTestSessionToken,
  sessionHeaders,
} from "./wallet-session-helpers.js";

const TEST_TOKEN = "test-coordinator-token";
const WEBHOOK_ORIGIN = "https://hooks.example.test";
const WEBHOOK_PATH = "/delegation-required";
const FAR_FUTURE = 4_102_444_800; // 2100-01-01

/** Poll until `cond` holds — fixed sleeps race waitUntil-driven delivery. */
async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  return {
    Authorization: `Bearer ${TEST_TOKEN}`,
    ...extra,
  };
}

function cborBody(value: unknown): Uint8Array {
  return encodeCborDeterministic(value);
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
      const logUuid = randomUUID();
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
      expect(event.certificateSubmitUrl).toBe(
        "http://localhost/api/delegations/certificate",
      );
      expect(event.materialSubmitUrl).toBe(
        "http://localhost/api/delegations/certificate",
      );

      const pubkeyHash = await import("../../src/certificate-key.js").then(
        (m) => m.sha256Hex(key),
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
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const webhookUrl = `${WEBHOOK_ORIGIN}${WEBHOOK_PATH}`;

    await registerWebhook(logUuid, webhookUrl);
    const disableRes = await fetchWithDoRetry(
      `http://localhost/admin/api/logs/${logUuid}/enabled`,
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
    const logUuid = randomUUID();
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

  // Safe 1x1 (Mode D): a wallet-routed log may still carry a webhook (e.g.
  // copied in by instance binding), but its root signs interactively — the
  // signer webhook must stay quiet and the demand must land in pending.
  it("signing-route mode=wallet suppresses emit, pending row remains", async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    try {
      const logUuid = randomUUID();
      const logHex32 = normalizeLogIdToHex32(logUuid);
      const webhookUrl = `${WEBHOOK_ORIGIN}${WEBHOOK_PATH}`;

      await registerWebhook(logUuid, webhookUrl);

      const routeToken = mintTestSessionToken({
        authLogIdHex32: logHex32,
        scopes: ["logs:signing-route:write"],
      });
      const routeRes = await fetchWithDoRetry(
        `http://localhost/api/logs/${logUuid}/signing-route`,
        {
          method: "POST",
          headers: sessionHeaders(routeToken, {
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ mode: "wallet" }),
        },
      );
      expect(routeRes.status).toBe(200);

      let delivered = false;
      fetchMock
        .get(WEBHOOK_ORIGIN)
        .intercept({ path: WEBHOOK_PATH, method: "POST" })
        .reply(200, () => {
          delivered = true;
          return "ok";
        })
        .persist();

      const miss = await postIssue({
        logHex32,
        mmrStart: 4,
        mmrEnd: 11,
        delegatedPublicKey: delegatedKey(9),
      });
      expect(miss.status).toBe(202);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(delivered).toBe(false);

      const pendingRes = await fetchWithDoRetry(
        `http://localhost/api/logs/${logUuid}/pending-delegation`,
      );
      expect(pendingRes.status).toBe(200);
      const pending = (await pendingRes.json()) as {
        entries: Array<{ mmrStart: number; mmrEnd: number }>;
      };
      expect(
        pending.entries.some((e) => e.mmrStart === 4 && e.mmrEnd === 11),
      ).toBe(true);

      // Positive control, same log + same interceptor: flip the route back to
      // http and the very same demand path DOES deliver — proving the
      // suppression assert above cannot pass vacuously (e.g. enqueue never
      // running or the interceptor being mis-wired).
      const httpRes = await fetchWithDoRetry(
        `http://localhost/api/logs/${logUuid}/signing-route`,
        {
          method: "POST",
          headers: sessionHeaders(routeToken, {
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ mode: "http" }),
        },
      );
      expect(httpRes.status).toBe(200);

      const controlMiss = await postIssue({
        logHex32,
        mmrStart: 5,
        mmrEnd: 12,
        delegatedPublicKey: delegatedKey(10),
      });
      expect(controlMiss.status).toBe(202);
      await waitFor(() => delivered);
      expect(delivered).toBe(true);
    } finally {
      fetchMock.deactivate();
    }
  });

  // H4 genesis PUSH suppression: setting a signing route fires the standing
  // delegation webhook when a standing delegate key exists — but never for a
  // wallet route, whose root signs interactively (Safe 1x1 Mode D, FOR-504).
  it("H4 standing push: wallet route stays quiet, http route fires", async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    try {
      const logUuid = randomUUID();
      const logHex32 = normalizeLogIdToHex32(logUuid);
      // Own path: earlier tests leave persist()ed interceptors on
      // WEBHOOK_PATH whose closures would swallow this test's deliveries.
      const h4Path = "/delegation-required-h4";
      const webhookUrl = `${WEBHOOK_ORIGIN}${h4Path}`;

      await registerWebhook(logUuid, webhookUrl);

      // A standing delegate key is registered BEFORE any route exists — the
      // route-set trigger is the only push candidate in this test.
      const keysRes = await fetchWithDoRetry(
        "http://localhost/api/sealer/delegate-keys",
        {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            sealerId: "sealer-h4",
            keys: [
              await delegateKeyEntryWithVoucher({
                sealerId: "sealer-h4",
                publicKey: testDelegatedCoseKey(77),
                epoch: 2,
                notAfter: FAR_FUTURE,
              }),
            ],
          }),
        },
      );
      expect(keysRes.status).toBe(200);

      let deliveries = 0;
      let lastBody = "";
      fetchMock
        .get(WEBHOOK_ORIGIN)
        .intercept({ path: h4Path, method: "POST" })
        .reply(200, (opts) => {
          deliveries += 1;
          lastBody = opts.body as string;
          return "ok";
        })
        .persist();

      const routeToken = mintTestSessionToken({
        authLogIdHex32: logHex32,
        scopes: ["logs:signing-route:write"],
      });
      const walletRes = await fetchWithDoRetry(
        `http://localhost/api/logs/${logUuid}/signing-route`,
        {
          method: "POST",
          headers: sessionHeaders(routeToken, {
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ mode: "wallet" }),
        },
      );
      expect(walletRes.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(deliveries).toBe(0);

      // Positive control: the http route's H4 push fires for the same
      // standing key, over the window-less [0,0] range.
      const httpRes = await fetchWithDoRetry(
        `http://localhost/api/logs/${logUuid}/signing-route`,
        {
          method: "POST",
          headers: sessionHeaders(routeToken, {
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ mode: "http" }),
        },
      );
      expect(httpRes.status).toBe(200);

      await waitFor(() => deliveries > 0);
      expect(deliveries).toBe(1);
      const event = JSON.parse(lastBody) as DelegationRequiredEvent;
      expect(event.type).toBe("delegation.required");
      expect(event.logId).toBe(logHex32);
      expect(event.mmrStart).toBe(0);
      expect(event.mmrEnd).toBe(0);
    } finally {
      fetchMock.deactivate();
    }
  });
});
