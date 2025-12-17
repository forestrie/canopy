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
    const der = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]);
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
    const derSig = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]);
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
    const alg = protectedHdr instanceof Map ? protectedHdr.get(1) : protectedHdr["1"];
    const cty = protectedHdr instanceof Map ? protectedHdr.get(3) : protectedHdr["3"];
    const hdrKid = protectedHdr instanceof Map ? protectedHdr.get(4) : protectedHdr["4"];

    expect(alg).toBe(-47);
    expect(cty).toBe("application/forestrie.delegation+cbor");
    expect(hdrKid).toBeInstanceOf(Uint8Array);
    expect((hdrKid as Uint8Array).byteLength).toBe(16);

    const payload = decodeCbor(payloadBytes) as any;
    const logId = payload instanceof Map ? payload.get(1) : payload["1"];
    expect(logId).toBe("log:forest-dev-1/arbor-dev-1");
  });

  it("returns a COSE_Sign1 delegation certificate for a prefix/no-log request", async () => {
    // Avoid calling KMS publicKey in this test by providing a deterministic kid.
    const kid = new Uint8Array(16);
    kid.fill(0xcd);
    (env as any).KMS_KID_SECP256K1_B64 = encodeB64(kid);

    // Stub KMS asymmetricSign call.
    const derSig = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]);
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


