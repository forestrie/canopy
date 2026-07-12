/**
 * Genesis one-shot coordinator forward (plan-0037 / FOR-100).
 */

import { encodeCborDeterministic } from "@forestrie/encoding";
import { decodeCborAsObject } from "./helpers/cbor-decode-object.js";
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { COSE_ALG_ES256, COSE_ALG_KS256 } from "../src/cose/cose-key.js";
import {
  buildCoordinatorPublicRootBody,
  forwardCoordinatorRegistration,
} from "../src/forest/forward-coordinator-registration.js";
import { logIdToWireBytes } from "../src/grant/log-id-wire.js";
import worker from "../src/index";
import type { Env } from "../src/index";
import {
  validGenesisV2Es256CborMap,
  validGenesisV2Ks256CborMap,
} from "./helpers/genesis-v2-body.js";
import { mintTestOnboardToken } from "./helpers/onboard-token.js";

const poolEnv = env as unknown as Env;
const COORD_URL = "https://coordinator.test";
const COORD_TOKEN = "coordinator-app-token-test";

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < value.length; i++) {
    binary += String.fromCharCode(value[i]!);
  }
  return btoa(binary);
}

function envWithCoordinator(): Env {
  return {
    ...poolEnv,
    DELEGATION_COORDINATOR_URL: COORD_URL,
    COORDINATOR_APP_TOKEN: COORD_TOKEN,
  };
}

async function genesisAuthHeader(e: Env): Promise<string> {
  const { token } = await mintTestOnboardToken(e, "coordinator-forward-test");
  return `Bearer ${token}`;
}

function genesisRequest(
  logId: string,
  bodyMap: Map<number, unknown>,
  opts?: { auth?: string; webhookUrl?: string },
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/cbor",
  };
  if (opts?.auth !== undefined) {
    headers.Authorization = opts.auth;
  }
  const query = opts?.webhookUrl
    ? `?webhookUrl=${encodeURIComponent(opts.webhookUrl)}`
    : "";
  return new Request(
    `http://localhost/api/forest/${encodeURIComponent(logId)}/genesis${query}`,
    {
      method: "POST",
      headers,
      body: encodeCborDeterministic(bodyMap),
    },
  );
}

describe("buildCoordinatorPublicRootBody", () => {
  it("maps ES256 bootstrapKey to x and y base64", () => {
    const key = new Uint8Array(64);
    key.fill(0x11, 0, 32);
    key.fill(0x22, 32, 64);
    const body = buildCoordinatorPublicRootBody(COSE_ALG_ES256, key);
    expect(body).toEqual({
      alg: "ES256",
      x: bytesToBase64(key.slice(0, 32)),
      y: bytesToBase64(key.slice(32, 64)),
    });
  });

  it("maps KS256 bootstrapKey to alg int and key base64", () => {
    const key = new Uint8Array(20).fill(0xaa);
    const body = buildCoordinatorPublicRootBody(COSE_ALG_KS256, key);
    expect(body).toEqual({
      alg: COSE_ALG_KS256,
      key: bytesToBase64(key),
    });
  });
});

describe("forwardCoordinatorRegistration", () => {
  it("POSTs public-root then PUTs webhook with app token bearer", async () => {
    const logId = crypto.randomUUID();
    const wire = logIdToWireBytes(logId);
    const bootstrapKey = new Uint8Array(20).fill(0xbb);
    const calls: {
      url: string;
      method: string;
      auth?: string;
      body?: string;
    }[] = [];

    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        calls.push({
          url,
          method: init?.method ?? "GET",
          auth: (init?.headers as Record<string, string>)?.Authorization,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return new Response("{}", { status: 200 });
      },
    ) as typeof fetch;

    const status = await forwardCoordinatorRegistration({
      coordinatorBaseUrl: COORD_URL,
      coordinatorAppToken: COORD_TOKEN,
      logIdWire: wire,
      genesisAlg: COSE_ALG_KS256,
      bootstrapKey,
      webhookUrl: "https://agent.example/webhook",
      fetchImpl,
    });

    expect(status).toEqual({ publicRoot: "ok", webhook: "ok" });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/public-root");
    expect(calls[0]!.auth).toBe(`Bearer ${COORD_TOKEN}`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      alg: COSE_ALG_KS256,
      key: bytesToBase64(bootstrapKey),
    });
    expect(calls[1]!.method).toBe("PUT");
    expect(calls[1]!.url).toContain("/webhook");
    expect(calls[1]!.auth).toBe(`Bearer ${COORD_TOKEN}`);
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      url: "https://agent.example/webhook",
    });
  });

  it("reports error when public-root fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const status = await forwardCoordinatorRegistration({
      coordinatorBaseUrl: COORD_URL,
      coordinatorAppToken: COORD_TOKEN,
      logIdWire: logIdToWireBytes(crypto.randomUUID()),
      genesisAlg: COSE_ALG_KS256,
      bootstrapKey: new Uint8Array(20).fill(1),
      webhookUrl: "https://agent.example/webhook",
      fetchImpl,
    });
    expect(status.publicRoot).toBe("error");
    expect(status.webhook).toBe("skipped");
    expect(status.detail).toMatch(/public-root returned 500/);
  });
});

describe("POST genesis coordinator forward", () => {
  it("without webhookUrl does not call coordinator", async () => {
    const e = envWithCoordinator();
    const logId = crypto.randomUUID();
    const auth = await genesisAuthHeader(e);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await worker.fetch(
      genesisRequest(logId, validGenesisV2Es256CborMap(), { auth }),
      e,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(201);
    const body = decodeCborAsObject(new Uint8Array(await res.arrayBuffer())) as {
      coordinator?: unknown;
    };
    expect(body.coordinator).toBeUndefined();
    const coordCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).startsWith(COORD_URL),
    );
    expect(coordCalls).toHaveLength(0);
    fetchSpy.mockRestore();
  });

  it("rejects invalid webhookUrl before genesis write", async () => {
    const e = envWithCoordinator();
    const logId = crypto.randomUUID();
    const auth = await genesisAuthHeader(e);

    const res = await worker.fetch(
      genesisRequest(logId, validGenesisV2Es256CborMap(), {
        auth,
        webhookUrl: "http://evil.example/hook",
      }),
      e,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it("returns 503 when webhookUrl present but coordinator unconfigured", async () => {
    const logId = crypto.randomUUID();
    const auth = await genesisAuthHeader(poolEnv);

    const res = await worker.fetch(
      genesisRequest(logId, validGenesisV2Es256CborMap(), {
        auth,
        webhookUrl: "https://agent.example/hook",
      }),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(503);
  });

  it("forwards ES256 public-root and webhook on genesis with webhookUrl", async () => {
    const e = envWithCoordinator();
    const logId = crypto.randomUUID();
    const auth = await genesisAuthHeader(e);
    const bootstrapKey = new Uint8Array(64).fill(0x33);
    const calls: { url: string; method: string; body?: string }[] = [];

    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (String(url).startsWith(COORD_URL)) {
          calls.push({
            url: String(url),
            method: init?.method ?? "GET",
            body: typeof init?.body === "string" ? init.body : undefined,
          });
        }
        return new Response("{}", { status: 200 });
      },
    ) as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const res = await worker.fetch(
      genesisRequest(logId, validGenesisV2Es256CborMap({ bootstrapKey }), {
        auth,
        webhookUrl: "https://agent.example/hook",
      }),
      e,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(201);
    const body = decodeCborAsObject(new Uint8Array(await res.arrayBuffer())) as {
      coordinator?: { publicRoot: string; webhook: string };
    };
    expect(body.coordinator).toEqual({ publicRoot: "ok", webhook: "ok" });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      alg: "ES256",
      x: bytesToBase64(bootstrapKey.slice(0, 32)),
      y: bytesToBase64(bootstrapKey.slice(32, 64)),
    });
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      url: "https://agent.example/hook",
    });

    vi.unstubAllGlobals();
  });

  it("forwards KS256 public-root body shape", async () => {
    const e = envWithCoordinator();
    const logId = crypto.randomUUID();
    const auth = await genesisAuthHeader(e);
    const bootstrapKey = new Uint8Array(20).fill(0x44);
    let publicRootBody: unknown;

    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (String(url).includes("/public-root")) {
          publicRootBody = JSON.parse(String(init?.body));
        }
        return new Response("{}", { status: 200 });
      },
    ) as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const res = await worker.fetch(
      genesisRequest(logId, validGenesisV2Ks256CborMap({ bootstrapKey }), {
        auth,
        webhookUrl: "https://agent.example/hook",
      }),
      e,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(201);
    expect(publicRootBody).toEqual({
      alg: COSE_ALG_KS256,
      key: bytesToBase64(bootstrapKey),
    });

    vi.unstubAllGlobals();
  });

  it("returns 503 when coordinator forward fails after genesis write", async () => {
    const e = envWithCoordinator();
    const logId = crypto.randomUUID();
    const auth = await genesisAuthHeader(e);

    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        if (url.includes("/public-root")) {
          return new Response("{}", { status: 500 });
        }
        return new Response("{}", { status: 200 });
      },
    ) as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const res = await worker.fetch(
      genesisRequest(logId, validGenesisV2Ks256CborMap(), {
        auth,
        webhookUrl: "https://agent.example/hook",
      }),
      e,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(503);

    vi.unstubAllGlobals();
  });
});
