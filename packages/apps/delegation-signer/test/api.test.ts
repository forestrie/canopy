import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";

import worker from "../src/index";
import { kmsDerSignatureToCoseRaw } from "../src/cose/sign1";

function encodeB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe("delegation-signer worker", () => {
  it("returns CBOR health status", async () => {
    const request = new Request("http://localhost/api/health");
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const data = decodeCbor(bytes) as any;
    expect(data).toHaveProperty("status", "healthy");
    expect(data).toHaveProperty("forestProjectId");
  });

  it("returns 401 problem-details when Authorization is missing", async () => {
    const request = new Request("http://localhost/api/delegations", {
      method: "POST",
      headers: {
        "content-type": "application/cbor",
      },
      body: new Uint8Array(),
    });
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(401);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pd = decodeCbor(bytes) as any;
    expect(pd).toHaveProperty("title", "Unauthorized");
    expect(pd).toHaveProperty("status", 401);
  });

  it("returns 415 problem-details when Content-Type is not application/cbor", async () => {
    const request = new Request("http://localhost/api/delegations", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "text/plain",
      },
      body: new Uint8Array(),
    });
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(415);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pd = decodeCbor(bytes) as any;
    expect(pd).toHaveProperty("title", "Unsupported Media Type");
    expect(pd).toHaveProperty("status", 415);
  });

  it("converts DER ECDSA signatures to raw r||s", () => {
    // SEQUENCE { INTEGER 1, INTEGER 2 }
    const der = new Uint8Array([
      0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02,
    ]);
    const raw = kmsDerSignatureToCoseRaw(der);
    expect(raw.byteLength).toBe(64);
    expect(raw[31]).toBe(1);
    expect(raw[63]).toBe(2);
  });

  it("returns a COSE_Sign1 delegation certificate on success", async () => {
    // Avoid calling KMS publicKey in this test by providing a deterministic kid.
    const kid = new Uint8Array(16);
    kid.fill(0xab);
    (env as any).KMS_KID_SECP256K1_B64 = encodeB64(kid);

    // Stub KMS asymmetricSign call.
    const derSig = new Uint8Array([
      0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02,
    ]);
    const signature = encodeB64(derSig);

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(":asymmetricSign")) {
        return new Response(JSON.stringify({ signature }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchStub);

    const delegatedKey = new Map<any, any>([
      [1, 2], // kty EC2
      [-1, 8], // crv secp256k1
      [-2, new Uint8Array(32).fill(1)],
      [-3, new Uint8Array(32).fill(2)],
    ]);

    const body = encodeCbor({
      log_id: "log:forest-dev-1/arbor-dev-1",
      mmr_start: 0,
      mmr_end: 10,
      delegated_pubkey: delegatedKey,
      constraints: new Map(),
    }) as Uint8Array;

    const request = new Request("http://localhost/api/delegations", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/cbor",
      },
      body: body as unknown as BodyInit,
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/cose");

    const coseBytes = new Uint8Array(await response.arrayBuffer());
    const cose = decodeCbor(coseBytes) as any[];
    expect(Array.isArray(cose)).toBe(true);
    expect(cose).toHaveLength(4);

    const protectedBytes = cose[0] as Uint8Array;
    const payloadBytes = cose[2] as Uint8Array;
    const signatureRaw = cose[3] as Uint8Array;

    expect(protectedBytes).toBeInstanceOf(Uint8Array);
    expect(payloadBytes).toBeInstanceOf(Uint8Array);
    expect(signatureRaw).toBeInstanceOf(Uint8Array);
    expect(signatureRaw.byteLength).toBe(64);
    expect(signatureRaw[31]).toBe(1);
    expect(signatureRaw[63]).toBe(2);

    const protectedHdr = decodeCbor(protectedBytes) as any;
    const alg =
      protectedHdr instanceof Map ? protectedHdr.get(1) : protectedHdr["1"];
    const cty =
      protectedHdr instanceof Map ? protectedHdr.get(3) : protectedHdr["3"];
    const hdrKid =
      protectedHdr instanceof Map ? protectedHdr.get(4) : protectedHdr["4"];

    expect(alg).toBe(-47);
    expect(cty).toBe("application/forestrie.delegation+cbor");
    expect(hdrKid).toBeInstanceOf(Uint8Array);
    expect((hdrKid as Uint8Array).byteLength).toBe(16);

    const payload = decodeCbor(payloadBytes) as any;
    const logId = payload instanceof Map ? payload.get(1) : payload["1"];
    expect(logId).toBe("log:forest-dev-1/arbor-dev-1");
  });

  it("returns COSE_Sign1 via Custodian raw-sign when CUSTODIAN_* is set", async () => {
    (env as any).CUSTODIAN_URL = "https://custodian.example";
    (env as any).CUSTODIAN_BOOTSTRAP_APP_TOKEN = "custodian-secret";
    delete (env as any).KMS_KID_SECP256K1_B64;
    delete (env as any).KMS_KID_SECP256R1_B64;

    const pem =
      "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==\n-----END PUBLIC KEY-----";

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("custodian.example") && url.includes("/public")) {
        return new Response(
          encodeCbor({
            keyId: ":bootstrap",
            publicKey: pem,
            alg: "ES256",
          }) as BodyInit,
          {
            status: 200,
            headers: { "content-type": "application/cbor" },
          },
        );
      }
      if (url.includes("custodian.example") && url.includes("/sign")) {
        const rawSig = new Uint8Array(64);
        rawSig.fill(0x55);
        return new Response(encodeCbor({ signature: rawSig }) as BodyInit, {
          status: 200,
          headers: { "content-type": "application/cbor" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    const delegatedKey = new Map<any, any>([
      [1, 2],
      [-1, 1],
      [-2, new Uint8Array(32).fill(1)],
      [-3, new Uint8Array(32).fill(2)],
    ]);
    const body = encodeCbor({
      delegated_pubkey: delegatedKey,
      constraints: new Map(),
    }) as Uint8Array;

    const request = new Request("http://localhost/api/delegations", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/cbor",
      },
      body: body as unknown as BodyInit,
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    const coseBytes = new Uint8Array(await response.arrayBuffer());
    const cose = decodeCbor(coseBytes) as any[];
    const signatureRaw = cose[3] as Uint8Array;
    expect(signatureRaw.byteLength).toBe(64);
    expect(signatureRaw.every((b) => b === 0x55)).toBe(true);

    expect(
      fetchStub.mock.calls.some((c) => String(c[0]).includes("/sign")),
    ).toBe(true);

    vi.unstubAllGlobals();
    delete (env as any).CUSTODIAN_URL;
    delete (env as any).CUSTODIAN_BOOTSTRAP_APP_TOKEN;
  });

  it("returns a COSE_Sign1 delegation certificate for a prefix/no-log request", async () => {
    // Avoid calling KMS publicKey in this test by providing a deterministic kid.
    const kid = new Uint8Array(16);
    kid.fill(0xcd);
    (env as any).KMS_KID_SECP256K1_B64 = encodeB64(kid);

    // Stub KMS asymmetricSign call.
    const derSig = new Uint8Array([
      0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02,
    ]);
    const signature = encodeB64(derSig);

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(":asymmetricSign")) {
        return new Response(JSON.stringify({ signature }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchStub);

    const delegatedKey = new Map<any, any>([
      [1, 2], // kty EC2
      [-1, 8], // crv secp256k1
      [-2, new Uint8Array(32).fill(1)],
      [-3, new Uint8Array(32).fill(2)],
    ]);

    const body = encodeCbor({
      log_id_prefix: "0xDeAdBeEf",
      delegated_pubkey: delegatedKey,
      constraints: new Map(),
    }) as Uint8Array;

    const request = new Request("http://localhost/api/delegations", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/cbor",
      },
      body: body as unknown as BodyInit,
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/cose");

    const coseBytes = new Uint8Array(await response.arrayBuffer());
    const cose = decodeCbor(coseBytes) as any[];
    expect(Array.isArray(cose)).toBe(true);
    expect(cose).toHaveLength(4);

    const payloadBytes = cose[2] as Uint8Array;
    const payload = decodeCbor(payloadBytes) as any;

    const logId = payload instanceof Map ? payload.get(1) : payload["1"];
    const mmrStart = payload instanceof Map ? payload.get(3) : payload["3"];
    const mmrEnd = payload instanceof Map ? payload.get(4) : payload["4"];
    expect(logId).toBeUndefined();
    expect(mmrStart).toBeUndefined();
    expect(mmrEnd).toBeUndefined();

    const constraints = payload instanceof Map ? payload.get(6) : payload["6"];
    const prefix =
      constraints instanceof Map
        ? constraints.get("log_id_prefix")
        : constraints?.log_id_prefix;
    expect(prefix).toBe("deadbeef");
  });

  it("enforces one-massif width policy", async () => {
    const delegatedKey = new Map<any, any>([
      [1, 2],
      [-1, 8],
      [-2, new Uint8Array(32).fill(1)],
      [-3, new Uint8Array(32).fill(2)],
    ]);

    const body = encodeCbor({
      log_id: "log:forest-dev-1/arbor-dev-1",
      mmr_start: 0,
      mmr_end: 20000,
      delegated_pubkey: delegatedKey,
    }) as Uint8Array;

    const request = new Request("http://localhost/api/delegations", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/cbor",
      },
      body: body as unknown as BodyInit,
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(403);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pd = decodeCbor(bytes) as any;
    expect(pd).toHaveProperty("title", "Forbidden");
  });
});

describe("grant-delegate (Plan 0004 subplan 04)", () => {
  const payloadHashHex =
    "0000000000000000000000000000000000000000000000000000000000000001";

  it("POST /api/delegate/bootstrap returns 401 without Authorization", async () => {
    const request = new Request("http://localhost/api/delegate/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload_hash: payloadHashHex }),
    });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(401);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pd = decodeCbor(bytes) as { title?: string };
    expect(pd.title).toBe("Unauthorized");
  });

  it("POST /api/delegate/bootstrap returns 415 without application/json", async () => {
    const request = new Request("http://localhost/api/delegate/bootstrap", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "text/plain",
      },
      body: JSON.stringify({ payload_hash: payloadHashHex }),
    });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(415);
  });

  it("POST /api/delegate/bootstrap returns 400 when payload_hash and cose_tbs_hash both missing", async () => {
    const request = new Request("http://localhost/api/delegate/bootstrap", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(400);
  });

  it("POST /api/delegate/bootstrap returns 400 when both payload_hash and cose_tbs_hash provided", async () => {
    const request = new Request("http://localhost/api/delegate/bootstrap", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        payload_hash: payloadHashHex,
        cose_tbs_hash: payloadHashHex,
      }),
    });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(400);
  });

  it("POST /api/delegate/bootstrap returns 200 and signature hex when KMS succeeds (payload_hash)", async () => {
    const derSig = new Uint8Array([
      0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02,
    ]);
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (String(url).includes(":asymmetricSign")) {
        return new Response(JSON.stringify({ signature: encodeB64(derSig) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    const request = new Request("http://localhost/api/delegate/bootstrap", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ payload_hash: payloadHashHex }),
    });
    const response = await worker.fetch(request, env);
    vi.unstubAllGlobals();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const data = (await response.json()) as { signature?: string };
    expect(data).toHaveProperty("signature");
    expect(typeof data.signature).toBe("string");
    expect(data.signature!.length).toBe(64 * 2); // 64 bytes as hex
  });

  it("POST /api/delegate/bootstrap returns 200 with test key when DELEGATION_SIGNER_USE_TEST_KEY=1 (no KMS)", async () => {
    (env as any).DELEGATION_SIGNER_USE_TEST_KEY = "1";
    const fetchCalls: string[] = [];
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      fetchCalls.push(String(url));
      return new Response("{}", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchStub);

    const request = new Request("http://localhost/api/delegate/bootstrap", {
      method: "POST",
      headers: {
        authorization: "Bearer any-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ cose_tbs_hash: payloadHashHex }),
    });
    const response = await worker.fetch(request, env);
    vi.unstubAllGlobals();
    delete (env as any).DELEGATION_SIGNER_USE_TEST_KEY;

    expect(response.status).toBe(200);
    const data = (await response.json()) as { signature?: string };
    expect(data.signature).toBeDefined();
    expect(data.signature!.length).toBe(128); // 64 bytes hex
    expect(fetchCalls).toHaveLength(0); // no KMS call
  });

  it("GET /api/public-key/:bootstrap returns 200 and PEM with test key (default ES256)", async () => {
    (env as any).DELEGATION_SIGNER_USE_TEST_KEY = "1";
    const request = new Request("http://localhost/api/public-key/:bootstrap");
    const response = await worker.fetch(request, env);
    delete (env as any).DELEGATION_SIGNER_USE_TEST_KEY;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/x-pem-file",
    );
    expect(response.headers.get("x-key-algorithm")).toBe("ES256");
    const pem = await response.text();
    expect(pem).toContain("-----BEGIN PUBLIC KEY-----");
    expect(pem).toContain("-----END PUBLIC KEY-----");
  });

  it("GET /api/public-key/:bootstrap?alg=KS256 returns 200 and PEM with test key (no token)", async () => {
    (env as any).DELEGATION_SIGNER_USE_TEST_KEY = "1";
    const request = new Request(
      "http://localhost/api/public-key/:bootstrap?alg=KS256",
    );
    const response = await worker.fetch(request, env);
    delete (env as any).DELEGATION_SIGNER_USE_TEST_KEY;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/x-pem-file",
    );
    expect(response.headers.get("x-key-algorithm")).toBe("KS256");
    const pem = await response.text();
    expect(pem).toContain("-----BEGIN PUBLIC KEY-----");
    expect(pem).toContain("-----END PUBLIC KEY-----");
  });

  it("POST /api/delegate/bootstrap with alg=KS256 uses test key (secp256k1)", async () => {
    (env as any).DELEGATION_SIGNER_USE_TEST_KEY = "1";
    const fetchStub = vi.fn(() => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchStub);

    const request = new Request("http://localhost/api/delegate/bootstrap", {
      method: "POST",
      headers: {
        authorization: "Bearer any",
        "content-type": "application/json",
      },
      body: JSON.stringify({ cose_tbs_hash: payloadHashHex, alg: "KS256" }),
    });
    const response = await worker.fetch(request, env);
    vi.unstubAllGlobals();
    delete (env as any).DELEGATION_SIGNER_USE_TEST_KEY;

    expect(response.status).toBe(200);
    const data = (await response.json()) as { signature?: string };
    expect(data.signature!.length).toBe(128);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("POST /api/delegate/bootstrap returns 200 and signature hex when cose_tbs_hash provided", async () => {
    const coseTbsHashHex =
      "0000000000000000000000000000000000000000000000000000000000000002";
    const derSig = new Uint8Array([
      0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02,
    ]);
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (String(url).includes(":asymmetricSign")) {
        return new Response(JSON.stringify({ signature: encodeB64(derSig) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    const request = new Request("http://localhost/api/delegate/bootstrap", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ cose_tbs_hash: coseTbsHashHex }),
    });
    const response = await worker.fetch(request, env);
    vi.unstubAllGlobals();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const data = (await response.json()) as { signature?: string };
    expect(data).toHaveProperty("signature");
    expect(data.signature!.length).toBe(64 * 2);
  });

  it("POST /api/delegate/parent returns 400 when parent_log_id missing", async () => {
    const request = new Request("http://localhost/api/delegate/parent", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ payload_hash: payloadHashHex }),
    });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(400);
  });

  it("POST /api/delegate/parent returns 404 for unknown parent when no root/parent keys", async () => {
    const request = new Request("http://localhost/api/delegate/parent", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        parent_log_id:
          "0x0000000000000000000000000000000000000000000000000000000000000099",
        payload_hash: payloadHashHex,
      }),
    });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(404);
  });

  it("POST /api/delegate/parent returns 200 when parent is root (ROOT_LOG_ID set)", async () => {
    const rootLogId =
      "0x0000000000000000000000000000000000000000000000000000000000000001";
    (env as any).DELEGATION_SIGNER_ROOT_LOG_ID = rootLogId;

    const derSig = new Uint8Array([
      0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02,
    ]);
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (String(url).includes(":asymmetricSign")) {
        return new Response(JSON.stringify({ signature: encodeB64(derSig) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    const request = new Request("http://localhost/api/delegate/parent", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        parent_log_id: rootLogId,
        payload_hash: payloadHashHex,
      }),
    });
    const response = await worker.fetch(request, env);
    vi.unstubAllGlobals();
    delete (env as any).DELEGATION_SIGNER_ROOT_LOG_ID;

    expect(response.status).toBe(200);
    const data = (await response.json()) as { signature?: string };
    expect(data).toHaveProperty("signature");
    expect(data.signature!.length).toBe(128);
  });
});

describe("GET /api/public-key/:well-known (no auth)", () => {
  const dummyPem =
    "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n";

  it("returns 503 when no Bearer and no DELEGATION_SIGNER_PUBLIC_KEY_ACCESS_TOKEN", async () => {
    const request = new Request("http://localhost/api/public-key/:bootstrap");
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(503);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pd = decodeCbor(bytes) as { title?: string; detail?: string };
    expect(pd.title).toBe("Service Unavailable");
    expect(pd.detail).toContain("Bearer token");
  });

  it("returns 200 and PEM with Bearer token (default ES256)", async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(
        typeof input === "string" ? input : (input as Request).url,
      );
      if (url.includes("/publicKey")) {
        return new Response(JSON.stringify({ pem: dummyPem }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    const request = new Request("http://localhost/api/public-key/:bootstrap", {
      headers: { authorization: "Bearer test-token" },
    });
    const response = await worker.fetch(request, env);
    vi.unstubAllGlobals();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-pem-file");
    expect(response.headers.get("x-key-algorithm")).toBe("ES256");
    const text = await response.text();
    expect(text).toContain("-----BEGIN PUBLIC KEY-----");
    expect(text).toContain("-----END PUBLIC KEY-----");
  });

  it("returns 200 and PEM with ?alg=KS256 (secp256k1)", async () => {
    let requestedKey = "";
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(
        typeof input === "string" ? input : (input as Request).url,
      );
      if (url.includes("/publicKey")) {
        requestedKey = url;
        return new Response(JSON.stringify({ pem: dummyPem }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    const request = new Request(
      "http://localhost/api/public-key/:bootstrap?alg=KS256",
      { headers: { authorization: "Bearer test-token" } },
    );
    const response = await worker.fetch(request, env);
    vi.unstubAllGlobals();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-key-algorithm")).toBe("KS256");
    expect(requestedKey).toContain("secp256k1");
  });

  it("returns 200 using DELEGATION_SIGNER_PUBLIC_KEY_ACCESS_TOKEN without Bearer", async () => {
    (env as any).DELEGATION_SIGNER_PUBLIC_KEY_ACCESS_TOKEN = "server-token";
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(
        typeof input === "string" ? input : (input as Request).url,
      );
      if (url.includes("/publicKey")) {
        return new Response(JSON.stringify({ pem: dummyPem }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    const request = new Request("http://localhost/api/public-key/:bootstrap");
    const response = await worker.fetch(request, env);
    vi.unstubAllGlobals();
    delete (env as any).DELEGATION_SIGNER_PUBLIC_KEY_ACCESS_TOKEN;

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("-----BEGIN PUBLIC KEY-----");
  });

  it("returns 404 for unknown well-known alias", async () => {
    const request = new Request("http://localhost/api/public-key/:other", {
      headers: { authorization: "Bearer test-token" },
    });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(404);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pd = decodeCbor(bytes) as { detail?: string };
    expect(pd.detail).toContain("Unknown well-known public key");
    expect(pd.detail).toContain(":bootstrap");
  });

  it("returns 404 for key-id (future)", async () => {
    const request = new Request("http://localhost/api/public-key/some-key-id", {
      headers: { authorization: "Bearer test-token" },
    });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(404);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pd = decodeCbor(bytes) as { detail?: string };
    expect(pd.detail).toContain("Unknown public key");
    expect(pd.detail).toContain("key-id");
  });

  it("returns 400 for invalid alg", async () => {
    const request = new Request(
      "http://localhost/api/public-key/:bootstrap?alg=RS256",
      { headers: { authorization: "Bearer test-token" } },
    );
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(400);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pd = decodeCbor(bytes) as { detail?: string };
    expect(pd.detail).toContain("ES256 or KS256");
  });
});
