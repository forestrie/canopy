/**
 * Owner-facing fee-account read (FOR-497): read-domain attestation vectors
 * (content-type domain separation both ways, the tighter window ceiling) and
 * GET /api/payments/accounts/{id} end-to-end against stubbed chain and
 * x402-settlement upstreams.
 */
import { p256 } from "@noble/curves/p256";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  encodeCborDeterministic,
  encodeSigStructure,
} from "@forestrie/encoding";
import { env } from "cloudflare:test";
import { describe, expect, it, vi, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import {
  CLAIM_CHAIN_BINDING,
  ONBOARD_ATTESTATION_CONTENT_TYPE,
  verifyOnboardAttestation,
} from "../src/onboarding/onboard-attestation.js";
import {
  ACCOUNT_READ_ATTESTATION_CONTENT_TYPE,
  verifyAccountReadAttestation,
} from "../src/payments/account-read-attestation.js";
import { ACCOUNT_READ_AUTH_SCHEME } from "../src/payments/account-read.js";
import {
  COSE_ALG_ES256,
  COSE_ALG_KS256,
  bootstrapConfigCallData,
  rootLogIdCallData,
} from "../src/onboarding/univocity-identity-probe.js";
import { decodeCborAsObject } from "./helpers/cbor-decode-object.js";

const poolEnv = env as unknown as Env;
const CHAIN = "84532";
const ADDR = "b".repeat(40);
const INSTANCE_ID = `eip155:${CHAIN}:0x${ADDR}`;
const AUD = "https://api.test";
const SETTLEMENT_URL = "https://settlement.test";
const OPS = "vitest-ops-admin-token";

const testCtx = {
  waitUntil: (_p: Promise<unknown>) => {},
} as ExecutionContext;

const ES256_PRIV = new Uint8Array(32).fill(7);
const ES256_PUB_XY = p256.getPublicKey(ES256_PRIV, false).slice(1);
const KS256_PRIV = new Uint8Array(32).fill(9);
const KS256_ADDR_BYTES = keccak_256(
  secp256k1.getPublicKey(KS256_PRIV, false).slice(1),
).slice(-20);

interface AttestationTweaks {
  signAlg?: number;
  contentType?: string;
  aud?: string;
  iat?: number;
  exp?: number;
  univocityAddr?: string;
}

function buildReadAttestation(
  nowSec: number,
  t: AttestationTweaks = {},
): Uint8Array {
  const signAlg = t.signAlg ?? COSE_ALG_ES256;
  const addr = t.univocityAddr ?? ADDR;
  const protectedBytes = encodeCborDeterministic(
    new Map<number, unknown>([
      [1, signAlg],
      [3, t.contentType ?? ACCOUNT_READ_ATTESTATION_CONTENT_TYPE],
    ]),
  );
  const claims = new Map<number, unknown>([
    [1, `eip155:${CHAIN}:0x${addr}`],
    [3, t.aud ?? AUD],
    [4, t.exp ?? nowSec + 120],
    [6, t.iat ?? nowSec - 60],
    [
      CLAIM_CHAIN_BINDING,
      new Map<number, unknown>([
        [1, CHAIN],
        [2, addr],
      ]),
    ],
  ]);
  const payloadBytes = encodeCborDeterministic(claims);
  const sigStructure = encodeSigStructure(
    protectedBytes,
    new Uint8Array(0),
    payloadBytes,
  );
  let signature: Uint8Array;
  if (signAlg === COSE_ALG_ES256) {
    signature = p256
      .sign(sha256(sigStructure), ES256_PRIV, { prehash: false })
      .toCompactRawBytes();
  } else {
    const sig = secp256k1.sign(keccak_256(sigStructure), KS256_PRIV, {
      prehash: false,
    });
    signature = new Uint8Array(65);
    signature.set(sig.toCompactRawBytes(), 0);
    signature[64] = (sig.recovery ?? 0) + 27;
  }
  return encodeCborDeterministic([
    protectedBytes,
    new Map(),
    payloadBytes,
    signature,
  ]);
}

function expectation(nowSec: number) {
  return {
    alg: COSE_ALG_ES256,
    key: ES256_PUB_XY,
    chainId: CHAIN,
    univocityAddr: ADDR,
    acceptedAud: [AUD],
    nowSec,
  };
}

const NOW = 1_753_600_000;

describe("verifyAccountReadAttestation — read-domain discipline", () => {
  it("accepts a valid read-typed attestation", () => {
    const v = verifyAccountReadAttestation(
      buildReadAttestation(NOW),
      expectation(NOW),
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.iss).toBe(INSTANCE_ID);
  });

  it("rejects an onboarding-typed envelope (captured-attestation replay)", () => {
    const v = verifyAccountReadAttestation(
      buildReadAttestation(NOW, {
        contentType: ONBOARD_ATTESTATION_CONTENT_TYPE,
      }),
      expectation(NOW),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toContain("content type");
  });

  it("rejects a read-typed envelope on the onboarding verifier (reverse replay)", () => {
    const v = verifyOnboardAttestation(
      buildReadAttestation(NOW),
      expectation(NOW),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toContain("content type");
  });

  it("enforces the tighter read window ceiling (onboarding's hour is too wide)", () => {
    const v = verifyAccountReadAttestation(
      buildReadAttestation(NOW, { iat: NOW - 60, exp: NOW - 60 + 3600 }),
      expectation(NOW),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toContain("policy ceiling");
  });
});

// --- GET /api/payments/accounts/{id} ---

const SUPPORTED_CHAINS_RPC = JSON.stringify({
  [CHAIN]: ["https://rpc.example.invalid"],
});

function bootstrapResultHex(
  alg: number = COSE_ALG_ES256,
  keyBytes: Uint8Array = ES256_PUB_XY,
): string {
  const algWord = ((1n << 64n) + BigInt(alg)).toString(16).padStart(64, "f");
  const offset = "40".padStart(64, "0");
  const len = keyBytes.length.toString(16).padStart(64, "0");
  const key = Array.from(keyBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${algWord}${offset}${len}${key}`;
}

const RECEIVABLES_BODY = {
  univocityInstanceId: INSTANCE_ID,
  entitlement: {
    univocityInstanceId: INSTANCE_ID,
    chainId: CHAIN,
    univocityAddr: ADDR,
    root: "11111111-1111-4111-8111-111111111111",
    registrationBlock: 28_100_000,
    checkpointsAccrued: 12,
    creditsBalance: 88,
    creditFloor: 0,
    arrears: "current",
    enforcementFrozen: false,
  },
  watermarkBlock: 28_100_042,
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubUpstreams(
  settlement: { status: number; body: unknown } = {
    status: 200,
    body: RECEIVABLES_BODY,
  },
  bootstrap: string = bootstrapResultHex(),
): void {
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(SETTLEMENT_URL)) {
      return new Response(JSON.stringify(settlement.body), {
        status: settlement.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body.method === "eth_call") {
      const data = body.params?.[0]?.data as string | undefined;
      const result =
        data === bootstrapConfigCallData()
          ? bootstrap
          : data === rootLogIdCallData()
            ? `0x${"00".repeat(32)}`
            : "0x";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "no" } }),
      { status: 200 },
    );
  }) as typeof fetch;
}

function requestEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...poolEnv,
    CANOPY_OPS_ADMIN_TOKEN: OPS,
    SUPPORTED_CHAINS_RPC,
    ONBOARD_ATTESTATION_AUD: AUD,
    X402_SETTLEMENT_URL: SETTLEMENT_URL,
    ...overrides,
  };
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccount(
  e: Env,
  headers: Record<string, string>,
  id: string = INSTANCE_ID,
): Promise<Response> {
  return worker.fetch(
    new Request(
      `http://localhost/api/payments/accounts/${encodeURIComponent(id)}`,
      { method: "GET", headers },
    ),
    e,
    testCtx,
  );
}

function freshAuthHeader(t: AttestationTweaks = {}): Record<string, string> {
  const now = Math.floor(Date.now() / 1000);
  return {
    Authorization: `${ACCOUNT_READ_AUTH_SCHEME} ${b64url(buildReadAttestation(now, t))}`,
  };
}

describe("GET /api/payments/accounts/{id}", () => {
  it("returns the owner-relevant read for a valid attestation (CBOR)", async () => {
    stubUpstreams();
    const res = await getAccount(requestEnv(), freshAuthHeader());
    expect(res.status).toBe(200);
    const body = decodeCborAsObject(
      new Uint8Array(await res.arrayBuffer()),
    ) as Record<string, unknown>;
    expect(body.univocityInstanceId).toBe(INSTANCE_ID);
    expect(body.creditsBalance).toBe(88);
    expect(body.checkpointsAccrued).toBe(12);
    expect(body.arrears).toBe("current");
    expect(body.enforcementFrozen).toBe(false);
    expect(body.registrationBlock).toBe(28_100_000);
    expect(body.watermarkBlock).toBe(28_100_042);
    // The owner view must not leak ops-internal fields.
    expect(body.creditFloor).toBeUndefined();
    expect(body.root).toBeUndefined();
  });

  it("returns JSON when Accept names application/json (console client)", async () => {
    stubUpstreams();
    const res = await getAccount(requestEnv(), {
      ...freshAuthHeader(),
      Accept: "application/json",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.creditsBalance).toBe(88);
    expect(body.enforcementFrozen).toBe(false);
  });

  it("401s without the attestation Authorization scheme", async () => {
    stubUpstreams();
    const missing = await getAccount(requestEnv(), {});
    expect(missing.status).toBe(401);
    const bearer = await getAccount(requestEnv(), {
      Authorization: `Bearer ${OPS}`,
    });
    expect(bearer.status).toBe(401);
  });

  it("403s an onboarding attestation replayed as a read credential", async () => {
    stubUpstreams();
    const res = await getAccount(
      requestEnv(),
      freshAuthHeader({ contentType: ONBOARD_ATTESTATION_CONTENT_TYPE }),
    );
    expect(res.status).toBe(403);
  });

  it("403s a stale attestation", async () => {
    stubUpstreams();
    const now = Math.floor(Date.now() / 1000);
    const res = await getAccount(
      requestEnv(),
      freshAuthHeader({ iat: now - 900, exp: now - 600 }),
    );
    expect(res.status).toBe(403);
  });

  it("400s a non-canonical instance id", async () => {
    stubUpstreams();
    const res = await getAccount(
      requestEnv(),
      freshAuthHeader(),
      `${CHAIN}:${ADDR}`,
    );
    expect(res.status).toBe(400);
  });

  it("404s when settlement has no account state", async () => {
    stubUpstreams({ status: 404, body: { error: "no account state" } });
    const res = await getAccount(requestEnv(), freshAuthHeader());
    expect(res.status).toBe(404);
  });

  it("503s when the settlement read is not configured", async () => {
    stubUpstreams();
    const res = await getAccount(
      requestEnv({ X402_SETTLEMENT_URL: undefined }),
      freshAuthHeader(),
    );
    expect(res.status).toBe(503);
  });

  it("accepts a KS256 read attestation end-to-end (EOA recovery)", async () => {
    // Distinct instance so no ES256 gate-cache entry can shadow the probe.
    const addr = "c".repeat(40);
    stubUpstreams(
      { status: 200, body: RECEIVABLES_BODY },
      bootstrapResultHex(COSE_ALG_KS256, KS256_ADDR_BYTES),
    );
    const res = await getAccount(
      requestEnv(),
      freshAuthHeader({ signAlg: COSE_ALG_KS256, univocityAddr: addr }),
      `eip155:${CHAIN}:0x${addr}`,
    );
    expect(res.status).toBe(200);
  });

  it("403s a wrong-aud attestation at the route (cross-operator replay)", async () => {
    stubUpstreams();
    const res = await getAccount(
      requestEnv(),
      freshAuthHeader({ aud: "https://other-operator.test" }),
    );
    expect(res.status).toBe(403);
  });

  it("429s before any upstream call when the shared limiter denies", async () => {
    stubUpstreams();
    const res = await getAccount(
      requestEnv({
        ONBOARD_CREATE_RATE_LIMITER: {
          limit: async () => ({ success: false }),
        },
      }),
      freshAuthHeader(),
    );
    expect(res.status).toBe(429);
    // The limiter must run before the chain probe and the settlement read.
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(0);
  });

  it("omits registrationBlock for a legacy account (absent, not null)", async () => {
    const { registrationBlock: _rb, ...legacyEntitlement } =
      RECEIVABLES_BODY.entitlement;
    stubUpstreams({
      status: 200,
      body: { ...RECEIVABLES_BODY, entitlement: legacyEntitlement },
    });
    const res = await getAccount(requestEnv(), freshAuthHeader());
    expect(res.status).toBe(200);
    const body = decodeCborAsObject(
      new Uint8Array(await res.arrayBuffer()),
    ) as Record<string, unknown>;
    expect(Object.hasOwn(body, "registrationBlock")).toBe(false);
  });
});
