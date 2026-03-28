/**
 * Bootstrap grant mint tests (Plan 0010, Plan 0011 §0, Plan 0014 Custodian).
 * POST /api/grants/bootstrap: optional body { rootLogId }, no server-side storage.
 */

import { encodeSigStructure } from "@canopy/encoding";
import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { sha256 } from "@noble/hashes/sha256";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { HEADER_FORESTRIE_GRANT_V0 } from "../src/grant/transparent-statement.js";
import { handlePostBootstrapGrant } from "../src/scrapi/bootstrap-grant";
import { publicKeyPemToUncompressed65 } from "../src/scrapi/custodian-grant";

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const ROOT_LOG_ID_64 =
  "550e8400e29b41d4a71644665544000000000000000000000000000000000000";

function spkiToPem(spki: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...spki));
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}

function publicKeyToGrantData64(keyBytes: Uint8Array): Uint8Array {
  if (keyBytes.length === 64) return keyBytes;
  if (keyBytes.length === 65 && keyBytes[0] === 0x04)
    return keyBytes.slice(1, 65);
  throw new Error("invalid key length");
}

let testPrivateKey: CryptoKey;
let testPublicPem: string;
const TEST_KID = new Uint8Array(16).fill(0xab);

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  testPrivateKey = pair.privateKey;
  const spkiBuf = (await crypto.subtle.exportKey(
    "spki",
    pair.publicKey,
  )) as ArrayBuffer;
  testPublicPem = spkiToPem(new Uint8Array(spkiBuf));
});

async function custodianSign1PayloadOnly(
  grantPayload: Uint8Array,
): Promise<Uint8Array> {
  const digest = sha256(grantPayload);
  const protectedMap = new Map<number, unknown>([
    [1, -7],
    [3, "application/forestrie.custodian-statement+cbor"],
    [4, TEST_KID],
  ]);
  const protectedInner = new Uint8Array(encodeCbor(protectedMap));
  const sigStructure = encodeSigStructure(
    protectedInner,
    new Uint8Array(0),
    digest,
  );
  const sigBuffer = sigStructure.buffer.slice(
    sigStructure.byteOffset,
    sigStructure.byteOffset + sigStructure.byteLength,
  ) as ArrayBuffer;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    testPrivateKey,
    sigBuffer,
  );
  return new Uint8Array(
    encodeCbor([protectedInner, new Map(), digest, new Uint8Array(signature)]),
  );
}

function mockCustodian() {
  return vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/public")) {
        const body = new Uint8Array(
          encodeCbor({
            keyId: ":bootstrap",
            publicKey: testPublicPem,
            alg: "ES256",
          }),
        );
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/cbor" },
        });
      }
      if (u.includes("/sign") && init?.method === "POST") {
        const ab = await new Response(init.body).arrayBuffer();
        const buf = new Uint8Array(ab);
        const req = decodeCbor(buf) as { payload?: Uint8Array };
        const payload = req.payload;
        if (!(payload instanceof Uint8Array)) {
          return new Response("bad payload", { status: 400 });
        }
        const sign1 = await custodianSign1PayloadOnly(payload);
        return new Response(sign1, {
          status: 200,
          headers: {
            "Content-Type": 'application/cose; cose-type="cose-sign1"',
          },
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${u}`));
    }),
  );
}

describe("handlePostBootstrapGrant", () => {
  it("returns 201 with base64 body when body has rootLogId (UUID)", async () => {
    mockCustodian();
    try {
      const request = new Request("http://localhost/api/grants/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootLogId: UUID }),
      });
      const response = await handlePostBootstrapGrant(request, {
        custodianUrl: "https://custodian.example",
        custodianBootstrapAppToken: "bootstrap-token",
      });
      expect(response.status).toBe(201);
      const body = await response.text();
      expect(body).toMatch(/^[A-Za-z0-9+/]+=*$/);
      const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
      const cose = decodeCbor(bytes) as unknown[];
      expect(cose).toHaveLength(4);
      const payload = cose[2] as Uint8Array;
      expect(payload.length).toBe(32);
      const uncompressed = publicKeyPemToUncompressed65(testPublicPem);
      const expectedGrantData = publicKeyToGrantData64(uncompressed);
      const unprot = cose[1] as Map<number, unknown>;
      const embedded = unprot.get(HEADER_FORESTRIE_GRANT_V0) as Uint8Array;
      expect(embedded).toBeInstanceOf(Uint8Array);
      const grantMap = decodeCbor(embedded) as Map<number, Uint8Array>;
      const logIdBytes = grantMap.get(1);
      expect(logIdBytes).toBeDefined();
      expect(logIdBytes!.length).toBe(32);
      const last16 = Array.from(logIdBytes!.slice(-16))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const expectedHex = UUID.replace(/-/g, "");
      expect(last16).toBe(expectedHex);
      const grantData = grantMap.get(6);
      expect(grantData).toBeDefined();
      expect(grantData!.length).toBe(64);
      expect(Array.from(grantData!)).toEqual(Array.from(expectedGrantData));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns 201 with base64 when body has logId (alias)", async () => {
    mockCustodian();
    try {
      const request = new Request("http://localhost/api/grants/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logId: UUID }),
      });
      const response = await handlePostBootstrapGrant(request, {
        custodianUrl: "https://custodian.example",
        custodianBootstrapAppToken: "bootstrap-token",
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
      custodianUrl: "https://custodian.example",
      custodianBootstrapAppToken: "token",
    });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("ROOT_LOG_ID not configured");
  });

  it("uses env.rootLogId when body is empty", async () => {
    mockCustodian();
    try {
      const request = new Request("http://localhost/api/grants/bootstrap", {
        method: "POST",
      });
      const response = await handlePostBootstrapGrant(request, {
        rootLogId: ROOT_LOG_ID_64,
        custodianUrl: "https://custodian.example",
        custodianBootstrapAppToken: "token",
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
      custodianUrl: "https://custodian.example",
      custodianBootstrapAppToken: "token",
    });
    expect(response.status).toBe(400);
  });

  it("returns 500 when alg is KS256 (grantData not implemented per Plan 0011 §0.5)", async () => {
    mockCustodian();
    try {
      const request = new Request("http://localhost/api/grants/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootLogId: UUID, alg: "KS256" }),
      });
      const response = await handlePostBootstrapGrant(request, {
        custodianUrl: "https://custodian.example",
        custodianBootstrapAppToken: "token",
      });
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain("KS256");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
