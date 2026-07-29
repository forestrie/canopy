/**
 * Bootstrap-key registrant attestation (plan-2607-43 slice 06, ADR-0059 D8):
 * per-alg vectors, freshness, aud, binding equality, unconfusability, and
 * the flag gate on POST /api/onboarding/requests.
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
import { Erc1271UnavailableError } from "@forestrie/chain-rpc";
import worker from "../src/index";
import type { Env } from "../src/index";
import {
  CLAIM_CHAIN_BINDING,
  ONBOARD_ATTESTATION_CONTENT_TYPE,
  verifyOnboardAttestation,
} from "../src/onboarding/onboard-attestation.js";
import {
  COSE_ALG_ES256,
  COSE_ALG_KS256,
  bootstrapConfigCallData,
  rootLogIdCallData,
} from "../src/onboarding/univocity-identity-probe.js";

const poolEnv = env as unknown as Env;
const OPS = "vitest-ops-admin-token";
const CHAIN = "84532";
const ADDR = "b".repeat(40);
const NOW = 1_753_600_000;
const AUD = "https://api.test";

const testCtx = {
  waitUntil: (_p: Promise<unknown>) => {},
} as ExecutionContext;

// Deterministic test keys.
const ES256_PRIV = new Uint8Array(32).fill(7);
const ES256_PUB_XY = p256.getPublicKey(ES256_PRIV, false).slice(1); // 64B x||y
const KS256_PRIV = new Uint8Array(32).fill(9);
const KS256_ADDR = keccak_256(
  secp256k1.getPublicKey(KS256_PRIV, false).slice(1),
).slice(-20);

interface AttestationTweaks {
  alg?: number;
  contentType?: string | null;
  aud?: string;
  iat?: number;
  exp?: number;
  chainId?: string;
  univocityAddr?: string;
  iss?: string | null;
  corruptSignature?: boolean;
  /** Replace the computed signature (contract-signer envelopes). */
  signature?: Uint8Array;
}

function buildAttestation(
  signAlg: number,
  t: AttestationTweaks = {},
): Uint8Array {
  const alg = t.alg ?? signAlg;
  const header = new Map<number, unknown>([[1, alg]]);
  const contentType =
    t.contentType === null
      ? undefined
      : (t.contentType ?? ONBOARD_ATTESTATION_CONTENT_TYPE);
  if (contentType !== undefined) header.set(3, contentType);
  const protectedBytes = encodeCborDeterministic(header);

  const binding = new Map<number, unknown>([
    [1, t.chainId ?? CHAIN],
    [2, t.univocityAddr ?? ADDR],
  ]);
  const claims = new Map<number, unknown>([
    [3, t.aud ?? AUD],
    [4, t.exp ?? NOW + 3600],
    [6, t.iat ?? NOW - 60],
    [CLAIM_CHAIN_BINDING, binding],
  ]);
  const iss =
    t.iss === null
      ? undefined
      : (t.iss ?? `eip155:${t.chainId ?? CHAIN}:0x${t.univocityAddr ?? ADDR}`);
  if (iss !== undefined) claims.set(1, iss);
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
  if (t.signature) signature = t.signature;
  if (t.corruptSignature) signature[10]! ^= 0xff;

  return encodeCborDeterministic([
    protectedBytes,
    new Map(),
    payloadBytes,
    signature,
  ]);
}

function expectation(
  overrides: Partial<Parameters<typeof verifyOnboardAttestation>[1]> = {},
) {
  return {
    alg: COSE_ALG_ES256,
    key: ES256_PUB_XY,
    chainId: CHAIN,
    univocityAddr: ADDR,
    acceptedAud: [AUD],
    nowSec: NOW,
    ...overrides,
  };
}

describe("verifyOnboardAttestation — per-alg vectors", () => {
  it("accepts a valid ES256 attestation", async () => {
    const v = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_ES256),
      expectation(),
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.iss).toBe(`eip155:${CHAIN}:0x${ADDR}`);
  });

  it("accepts a valid KS256 attestation via EOA recovery", async () => {
    const v = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_KS256),
      expectation({ alg: COSE_ALG_KS256, key: KS256_ADDR }),
    );
    expect(v.ok).toBe(true);
  });

  it("rejects a corrupted signature under both algs", async () => {
    for (const [alg, key] of [
      [COSE_ALG_ES256, ES256_PUB_XY],
      [COSE_ALG_KS256, KS256_ADDR],
    ] as const) {
      const v = await verifyOnboardAttestation(
        buildAttestation(alg, { corruptSignature: true }),
        expectation({ alg, key }),
      );
      expect(v.ok).toBe(false);
    }
  });

  it("rejects an envelope alg that disagrees with the chain alg", async () => {
    // Envelope claims KS256 while the chain declares ES256 — the trust
    // anchor comes from the chain, never from the envelope.
    const v = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_ES256, { alg: COSE_ALG_KS256 }),
      expectation(),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toContain("does not match chain bootstrapAlg");
  });

  it("an alg with no verifier row never verifies", async () => {
    // The strategy-table contract: a chain-declared alg outside ALG_VERIFIERS
    // fails signature verification rather than falling into either branch.
    const v = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_ES256, { alg: -999 }),
      expectation({ alg: -999 }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toContain("signature invalid");
  });

  it("rejects a KS256 signature recovering to a different address", async () => {
    const v = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_KS256),
      expectation({ alg: COSE_ALG_KS256, key: new Uint8Array(20).fill(1) }),
    );
    expect(v.ok).toBe(false);
  });
});

describe("verifyOnboardAttestation — claims discipline", () => {
  it("rejects a wrong aud (cross-operator replay)", async () => {
    const v = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_ES256, { aud: "https://other-operator.test" }),
      expectation(),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toContain("aud");
  });

  it("rejects expired and not-yet-valid windows", async () => {
    const expired = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_ES256, { iat: NOW - 7200, exp: NOW - 3600 }),
      expectation(),
    );
    expect(expired.ok).toBe(false);
    const future = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_ES256, { iat: NOW + 3600, exp: NOW + 7200 }),
      expectation(),
    );
    expect(future.ok).toBe(false);
  });

  it("rejects a window wider than the policy ceiling", async () => {
    const v = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_ES256, {
        iat: NOW - 60,
        exp: NOW - 60 + 48 * 3600,
      }),
      expectation(),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toContain("policy ceiling");
  });

  it("rejects a chainBinding claim that names a different contract", async () => {
    const v = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_ES256, { univocityAddr: "c".repeat(40) }),
      expectation(),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toContain("chainBinding");
  });

  it("tolerates a missing iss but rejects one naming another instance", async () => {
    const missing = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_ES256, { iss: null }),
      expectation(),
    );
    expect(missing.ok).toBe(true);
    const other = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_ES256, {
        iss: `eip155:${CHAIN}:0x${"d".repeat(40)}`,
      }),
      expectation(),
    );
    expect(other.ok).toBe(false);
  });

  it("unconfusability: a differently content-typed envelope never verifies", async () => {
    // The same key signs bootstrap grants and delegation certificates under
    // other content types — signed-content-type discrimination must reject
    // them even with a valid signature.
    const v = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_ES256, {
        contentType: "application/forestrie.delegation+cbor",
      }),
      expectation(),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toContain("content type");
    const untyped = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_ES256, { contentType: null }),
      expectation(),
    );
    expect(untyped.ok).toBe(false);
  });
});

describe("verifyOnboardAttestation — contract-account roots (ERC-1271 hooks)", () => {
  // Safe 1x1 (Mode D, plan-2607-45): the KS256 address belongs to a contract
  // account; hooks replace recovery and the 65-byte EOA rule must not apply.
  const CONTRACT_ADDR = new Uint8Array(20).fill(0xcd);
  const CONTRACT_SIG = new Uint8Array(96).fill(0x33);

  function hooksOf(overrides: {
    hasContractCode?: () => Promise<boolean>;
    isValidSignature?: () => Promise<boolean>;
  }) {
    return {
      hasContractCode: overrides.hasContractCode ?? (async () => true),
      isValidSignature: overrides.isValidSignature ?? (async () => true),
    };
  }

  it("accepts a non-65-byte contract signature when ERC-1271 accepts", async () => {
    const v = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_KS256, { signature: CONTRACT_SIG }),
      expectation({ alg: COSE_ALG_KS256, key: CONTRACT_ADDR }),
      { erc1271: hooksOf({}) },
    );
    expect(v.ok).toBe(true);
  });

  it("rejects when ERC-1271 rejects", async () => {
    const v = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_KS256, { signature: CONTRACT_SIG }),
      expectation({ alg: COSE_ALG_KS256, key: CONTRACT_ADDR }),
      { erc1271: hooksOf({ isValidSignature: async () => false }) },
    );
    expect(v.ok).toBe(false);
  });

  it("fails closed when the code check errors — never falls back to ecrecover", async () => {
    // A perfectly valid EOA-signed envelope must still reject when we cannot
    // establish whether the address holds code.
    const v = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_KS256),
      expectation({ alg: COSE_ALG_KS256, key: KS256_ADDR }),
      {
        erc1271: hooksOf({
          hasContractCode: async () => {
            throw new Error("rpc down");
          },
        }),
      },
    );
    expect(v.ok).toBe(false);
  });

  it("fails closed when the ERC-1271 call errors", async () => {
    const v = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_KS256, { signature: CONTRACT_SIG }),
      expectation({ alg: COSE_ALG_KS256, key: CONTRACT_ADDR }),
      {
        erc1271: hooksOf({
          isValidSignature: async () => {
            throw new Error("rpc down");
          },
        }),
      },
    );
    expect(v.ok).toBe(false);
  });

  it("EOA roots verify unchanged when the address has no code", async () => {
    const v = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_KS256),
      expectation({ alg: COSE_ALG_KS256, key: KS256_ADDR }),
      { erc1271: hooksOf({ hasContractCode: async () => false }) },
    );
    expect(v.ok).toBe(true);
  });

  it("RPC unavailability is an availability outcome, not a verdict", async () => {
    // The typed error surfaces as { unavailable: true } so boundaries answer
    // 503; a plain hook error (previous tests) stays a plain rejection.
    const v = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_KS256, { signature: CONTRACT_SIG }),
      expectation({ alg: COSE_ALG_KS256, key: CONTRACT_ADDR }),
      {
        erc1271: hooksOf({
          hasContractCode: async () => {
            throw new Erc1271UnavailableError("eth_getCode", new Error("down"));
          },
        }),
      },
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.unavailable).toBe(true);
  });

  it("a plain verifier rejection is NOT marked unavailable", async () => {
    const v = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_KS256, { signature: CONTRACT_SIG }),
      expectation({ alg: COSE_ALG_KS256, key: CONTRACT_ADDR }),
      { erc1271: hooksOf({ isValidSignature: async () => false }) },
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.unavailable).toBeUndefined();
  });
});

// --- flag gate on POST /api/onboarding/requests ---

const SUPPORTED_CHAINS_RPC = JSON.stringify({
  [CHAIN]: ["https://rpc.example.invalid"],
});

/** bootstrapConfig() eth_call result carrying the ES256 test key. */
function bootstrapResultHex(): string {
  const alg = ((1n << 64n) + BigInt(COSE_ALG_ES256))
    .toString(16)
    .padStart(64, "f");
  const offset = "40".padStart(64, "0");
  const len = "40".padStart(64, "0");
  const key = Array.from(ES256_PUB_XY)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${alg}${offset}${len}${key}`;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubChain(): void {
  globalThis.fetch = vi.fn(async (_input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body.method === "eth_call") {
      const data = body.params?.[0]?.data as string | undefined;
      const result =
        data === bootstrapConfigCallData()
          ? bootstrapResultHex()
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
    ...overrides,
  };
}

async function postCreate(
  e: Env,
  fields: Map<number, unknown>,
): Promise<Response> {
  return worker.fetch(
    new Request("http://localhost/api/onboarding/requests", {
      method: "POST",
      headers: { "Content-Type": "application/cbor" },
      body: encodeCborDeterministic(fields) as unknown as BodyInit,
    }),
    e,
    testCtx,
  );
}

function baseFields(addr = ADDR): Map<number, unknown> {
  return new Map<number, unknown>([
    [1, "attestation-test"],
    [2, CHAIN],
    [3, addr],
    [4, "owner@example.test"],
  ]);
}

describe("POST /api/onboarding/requests — attestation gate (slice 06)", () => {
  it("flag off: absent attestation passes through", async () => {
    stubChain();
    const res = await postCreate(requestEnv(), baseFields());
    expect(res.status).toBe(201);
  });

  it("flag off: a present-but-invalid attestation still rejects (403)", async () => {
    stubChain();
    const bad = buildAttestation(COSE_ALG_ES256, { corruptSignature: true });
    const fields = baseFields();
    fields.set(7, bad);
    const res = await postCreate(requestEnv(), fields);
    expect(res.status).toBe(403);
  });

  it("flag on: absent attestation is a 400", async () => {
    stubChain();
    const res = await postCreate(
      requestEnv({ ONBOARD_REQUIRE_KEY_ATTESTATION: "true" }),
      baseFields(),
    );
    expect(res.status).toBe(400);
  });

  it("flag on: a valid attestation is accepted, recorded, and retained", async () => {
    stubChain();
    // NOW is a fixed test epoch; the handler reads the real clock, so issue a
    // fresh attestation around the live clock instead.
    const now = Math.floor(Date.now() / 1000);
    const fields = baseFields();
    fields.set(
      7,
      buildAttestation(COSE_ALG_ES256, { iat: now - 60, exp: now + 3600 }),
    );
    const res = await postCreate(
      requestEnv({ ONBOARD_REQUIRE_KEY_ATTESTATION: "true" }),
      fields,
    );
    expect(res.status).toBe(201);
    const stored = await poolEnv.R2_GRANTS.get(
      `payments/attestations/eip155:${CHAIN}:0x${ADDR}.cose`,
    );
    expect(stored).not.toBeNull();
    // Consume the body: an open R2 read handle breaks the isolated-storage
    // frame pop at teardown (miniflare sqlite-shm assertion).
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
  });
});
