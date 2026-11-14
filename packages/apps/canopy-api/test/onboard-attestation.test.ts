/**
 * Bootstrap-key registrant attestation (ADR-0059 D8):
 * per-alg vectors, freshness, aud, binding equality, unconfusability, and
 * the required-attestation gate on POST /api/onboarding/requests.
 */
import { p256 } from "@noble/curves/p256";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  decodeCborDeterministic,
  encodeCborDeterministic,
  encodeSigStructure,
} from "@forestrie/encoding";
import { env } from "cloudflare:test";
import { describe, expect, it, vi, afterEach } from "vitest";
import { Erc1271UnavailableError } from "@forestrie/chain-rpc";
import { tryUnivocityInstanceIdFromChainBinding } from "@canopy/univocity-instance-id";
import worker from "../src/index";
import type { Env } from "../src/index";
import { decodeCborAsObject } from "./helpers/cbor-decode-object.js";
import {
  listOnboardTokens,
  mintOnboardToken,
} from "../src/payments/onboard-token-store.js";
import {
  readUnivocityInstanceReservation,
  requestHolder,
  reserveUnivocityInstance,
} from "../src/payments/instance-registry.js";
import {
  createOnboardRequest,
  listOnboardRequests,
  readOnboardRequest,
  transitionApprovedToRedeemedCas,
  transitionPendingToApprovedCas,
  transitionPendingToRejectedCas,
} from "../src/onboarding/onboard-request-store.js";
import { onboardRequestR2Key } from "../src/onboarding/onboard-request-hash.js";
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
import {
  seedGenesisChainIdentity,
  validGenesisV2Es256CborMap,
} from "./helpers/genesis-v2-body.js";

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
  /** KS256 only: replace (r, s, v) with its high-s twin (r, n-s, v^1). */
  highS?: boolean;
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
    if (t.highS) {
      const twin = new secp256k1.Signature(sig.r, secp256k1.CURVE.n - sig.s);
      signature.set(twin.toCompactRawBytes(), 0);
      // Flip the recovery bit, whether v is written 0/1 or 27/28.
      const v = signature[64]!;
      signature[64] = v >= 27 ? 27 + ((v - 27) ^ 1) : v ^ 1;
    }
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

  it("rejects the high-s twin of a valid KS256 attestation", async () => {
    // (r, n-s, v^1) recovers the same address; only the s bound refuses it.
    const v = await verifyOnboardAttestation(
      buildAttestation(COSE_ALG_KS256, { highS: true }),
      expectation({ alg: COSE_ALG_KS256, key: KS256_ADDR }),
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

// --- required-attestation gate on POST /api/onboarding/requests ---

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

describe("POST /api/onboarding/requests — attestation gate", () => {
  it("a present-but-invalid attestation is rejected (403)", async () => {
    stubChain();
    const bad = buildAttestation(COSE_ALG_ES256, { corruptSignature: true });
    const fields = baseFields();
    fields.set(7, bad);
    const res = await postCreate(requestEnv(), fields);
    expect(res.status).toBe(403);
  });

  // Dev auto-approve config shared by the refusal row and its positive
  // control, which pins that the row really is auto-approve-eligible.
  const AUTO_APPROVE: Partial<Env> = {
    ONBOARD_AUTO_APPROVE: "true",
    ONBOARD_AUTO_APPROVE_CHAIN_IDS: CHAIN,
    ONBOARD_AUTO_APPROVE_LABEL_PREFIX: "dev-auto-",
  };
  const AUTO_APPROVE_LABEL = "dev-auto-x";

  // Q46: auto-approve is no exception — an eligible request is refused too.
  it.each([
    ["a plain", {}, "attestation-test"],
    ["an auto-approve-eligible", AUTO_APPROVE, AUTO_APPROVE_LABEL],
  ] as const)(
    "%s request without an attestation is refused (400)",
    async (_kind, overrides, label) => {
      stubChain();
      const e = requestEnv(overrides);
      const fields = baseFields();
      fields.set(1, label);
      const res = await postCreate(e, fields);
      expect(res.status).toBe(400);
      const listed = await listOnboardRequests(e);
      expect(listed.requests.filter((r) => r.label === label)).toEqual([]);
    },
  );

  it("the same auto-approve-eligible request with an attestation is approved (201)", async () => {
    stubChain();
    const now = Math.floor(Date.now() / 1000);
    const fields = baseFields();
    fields.set(1, AUTO_APPROVE_LABEL);
    fields.set(
      7,
      buildAttestation(COSE_ALG_ES256, { iat: now - 60, exp: now + 3600 }),
    );
    const res = await postCreate(requestEnv(AUTO_APPROVE), fields);
    expect(res.status).toBe(201);
    const body = decodeCborAsObject(
      new Uint8Array(await res.arrayBuffer()),
    ) as {
      status?: string;
    };
    expect(body.status).toBe("approved");
  });

  // Single use: the stored attestation is publicly readable, so a copy of a
  // spent one must not mint a second request.
  describe("single-use claim", () => {
    function attestedFields(iatOffset = 60): Map<number, unknown> {
      const now = Math.floor(Date.now() / 1000);
      const fields = baseFields();
      fields.set(
        7,
        buildAttestation(COSE_ALG_ES256, {
          iat: now - iatOffset,
          exp: now + 3600,
        }),
      );
      return fields;
    }

    /** Same signed bytes, different (unsigned) unprotected header. */
    function rewrapped(attestation: Uint8Array): Uint8Array {
      const [protectedBytes, , payloadBytes, signature] =
        decodeCborDeterministic(attestation) as [
          Uint8Array,
          Map<unknown, unknown>,
          Uint8Array,
          Uint8Array,
        ];
      return encodeCborDeterministic([
        protectedBytes,
        new Map([[4, new Uint8Array([1, 2, 3])]]),
        payloadBytes,
        signature,
      ]);
    }

    /**
     * Same signed bytes, the other valid ES256 signature (r, n-s): ES256
     * verifies high-s, so anyone can make this twin without the key.
     */
    function otherSignature(attestation: Uint8Array): Uint8Array {
      const [protectedBytes, unprotected, payloadBytes, signature] =
        decodeCborDeterministic(attestation) as [
          Uint8Array,
          Map<unknown, unknown>,
          Uint8Array,
          Uint8Array,
        ];
      const sig = p256.Signature.fromCompact(signature);
      const twin = new p256.Signature(sig.r, p256.CURVE.n - sig.s);
      return encodeCborDeterministic([
        protectedBytes,
        unprotected,
        payloadBytes,
        twin.toCompactRawBytes(),
      ]);
    }

    it.each([
      ["the same attestation bytes", 409, (f: Map<number, unknown>) => f],
      [
        "the same signed content, different unprotected header",
        409,
        (f: Map<number, unknown>) =>
          new Map(f).set(7, rewrapped(f.get(7) as Uint8Array)),
      ],
      [
        "the same signed content, the other valid ECDSA signature",
        409,
        (f: Map<number, unknown>) =>
          new Map(f).set(7, otherSignature(f.get(7) as Uint8Array)),
      ],
      [
        "a fresh attestation for the same binding",
        201,
        (_f: Map<number, unknown>) => attestedFields(120),
      ],
    ])("a second create with %s answers %i", async (_what, status, second) => {
      stubChain();
      const e = requestEnv();
      const first = attestedFields();
      expect((await postCreate(e, first)).status).toBe(201);
      const res = await postCreate(e, second(first));
      expect(res.status).toBe(status);
    });

    it("a create refused by the pending cap does not burn the attestation", async () => {
      stubChain();
      const e = requestEnv();
      const addr = "3".repeat(40);
      const chainBinding = { chainId: CHAIN, univocityAddr: addr };
      for (let i = 0; i < 3; i++) {
        await createOnboardRequest(e, {
          label: "filler",
          chainBinding,
          contactEmail: "owner@example.test",
          ttlSec: 3600,
          attested: true,
        });
      }
      const now = Math.floor(Date.now() / 1000);
      const fields = baseFields(addr);
      fields.set(
        7,
        buildAttestation(COSE_ALG_ES256, {
          univocityAddr: addr,
          iat: now - 60,
          exp: now + 3600,
        }),
      );
      expect((await postCreate(e, fields)).status).toBe(409);
      // Make room: reject one filler so the cap no longer refuses.
      const pending = (await listOnboardRequests(e)).requests.filter(
        (r) => r.label === "filler" && r.status === "pending",
      );
      await transitionPendingToRejectedCas(e, pending[0]!.requestId, "room");
      expect((await postCreate(e, fields)).status).toBe(201);
    });
  });

  it("a valid attestation is accepted, recorded, and retained", async () => {
    stubChain();
    // NOW is a fixed test epoch; the handler reads the real clock, so issue a
    // fresh attestation around the live clock instead.
    const now = Math.floor(Date.now() / 1000);
    const fields = baseFields();
    fields.set(
      7,
      buildAttestation(COSE_ALG_ES256, { iat: now - 60, exp: now + 3600 }),
    );
    const res = await postCreate(requestEnv(), fields);
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

// --- hard cutover: requests created before attestation was required ---

describe("onboard requests without an attestation mark (Q46 hard cutover)", () => {
  // A request created before the cutover has no `attested` mark. Whatever
  // state it reached, it must never be admitted: no approve, redeem or
  // reissue, and no genesis with a token it already produced, so the
  // pre-cutover bypass closes at deploy, not at expiresAt.
  async function seedUnattested(
    e: Env,
    addr: string,
    reach: "pending" | "approved" | "redeemed",
  ): Promise<{ requestId: string; redeemCode: string }> {
    const { record, redeemCode } = await createOnboardRequest(e, {
      label: "pre-cutover",
      chainBinding: { chainId: CHAIN, univocityAddr: addr },
      contactEmail: "owner@example.test",
      ttlSec: 3600,
    });
    if (reach !== "pending") {
      await transitionPendingToApprovedCas(e, record.requestId);
    }
    if (reach === "redeemed") {
      await transitionApprovedToRedeemedCas(e, record.requestId);
    }
    return { requestId: record.requestId, redeemCode };
  }

  async function problemDetail(res: Response): Promise<string | undefined> {
    const body = decodeCborAsObject(
      new Uint8Array(await res.arrayBuffer()),
    ) as {
      detail?: string;
    };
    return body.detail;
  }

  it.each([
    ["pending", "c".repeat(40)],
    ["approved", "d".repeat(40)],
    ["redeemed", "e".repeat(40)],
  ] as const)(
    "redeem of an unattested %s record is refused (409), mints nothing",
    async (reach, addr) => {
      const e = requestEnv();
      const { requestId, redeemCode } = await seedUnattested(e, addr, reach);
      const res = await worker.fetch(
        new Request(
          `http://localhost/api/onboarding/requests/${requestId}/redeem`,
          {
            method: "POST",
            headers: { "Content-Type": "application/cbor" },
            body: encodeCborDeterministic(
              new Map<number, unknown>([[1, redeemCode]]),
            ) as unknown as BodyInit,
          },
        ),
        e,
        testCtx,
      );
      expect(res.status).toBe(409);
      expect(await problemDetail(res)).toContain("attestation");
      const tokens = await listOnboardTokens(e);
      expect(tokens.filter((t) => t.requestId === requestId)).toEqual([]);
      const instanceId = tryUnivocityInstanceIdFromChainBinding({
        chainId: CHAIN,
        univocityAddr: addr,
      });
      expect(await readUnivocityInstanceReservation(e, instanceId!)).toBeNull();
    },
  );

  it("ops approve of a pending record is refused (409)", async () => {
    const e = requestEnv();
    const { requestId } = await seedUnattested(e, "f".repeat(40), "pending");
    const res = await worker.fetch(
      new Request(
        `http://localhost/api/onboarding/requests/${requestId}/approve`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPS}`,
            "Content-Type": "application/cbor",
          },
        },
      ),
      e,
      testCtx,
    );
    expect(res.status).toBe(409);
    expect(await problemDetail(res)).toContain("attestation");
    expect((await readOnboardRequest(e, requestId))?.status).toBe("pending");
  });

  // An unattested record can never be admitted, so it must not hold one of
  // the binding's pending slots (cap 3) against the owner's attested create.
  it.each([
    ["unattested", 201, false, "1".repeat(40)],
    ["attested", 409, true, "2".repeat(40)],
  ] as const)(
    "three %s pending records, then an attested create answers %i",
    async (_kind, status, attested, addr) => {
      stubChain();
      const e = requestEnv();
      for (let i = 0; i < 3; i++) {
        await createOnboardRequest(e, {
          label: "pre-cutover",
          chainBinding: { chainId: CHAIN, univocityAddr: addr },
          contactEmail: "owner@example.test",
          ttlSec: 3600,
          attested,
        });
      }
      const now = Math.floor(Date.now() / 1000);
      const fields = baseFields(addr);
      fields.set(
        7,
        buildAttestation(COSE_ALG_ES256, {
          univocityAddr: addr,
          iat: now - 60,
          exp: now + 3600,
        }),
      );
      const res = await postCreate(e, fields);
      expect(res.status).toBe(status);
    },
  );

  // A token redeemed from an unattested request before the cutover is still
  // active. Genesis must refuse it, or it sets the instance root (P14).
  it.each([
    ["an attested", 201, true, 0x71, "registered"],
    ["an unattested", 403, false, 0x72, "reserved"],
  ] as const)(
    "genesis with a token redeemed from %s request answers %i",
    async (_kind, status, attested, addrByte, reservationState) => {
      stubChain();
      const e = requestEnv();
      const chainBinding = {
        chainId: CHAIN,
        univocityAddr: addrByte.toString(16).repeat(20),
      };
      const { record } = await createOnboardRequest(e, {
        label: "pre-cutover-token",
        chainBinding,
        contactEmail: "owner@example.test",
        ttlSec: 3600,
        attested,
      });
      await transitionPendingToApprovedCas(e, record.requestId);
      await transitionApprovedToRedeemedCas(e, record.requestId);
      // Redeem stamps the token from the request; a pre-cutover token has
      // no stamp at all.
      const minted = await mintOnboardToken(e, {
        label: record.label,
        requestId: record.requestId,
        chainBinding,
        admittedBy: "ops",
        attested: attested ? true : undefined,
      });
      const instanceId = tryUnivocityInstanceIdFromChainBinding(chainBinding)!;
      await reserveUnivocityInstance(
        e,
        instanceId,
        requestHolder(record.requestId),
      );

      const genesisMap = validGenesisV2Es256CborMap({
        chainId: CHAIN,
        univocityAddr: new Uint8Array(20).fill(addrByte),
      });
      await seedGenesisChainIdentity(e, genesisMap);
      const res = await worker.fetch(
        new Request(
          `http://localhost/api/forest/${crypto.randomUUID()}/genesis`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${minted.token}`,
              "Content-Type": "application/cbor",
            },
            body: encodeCborDeterministic(genesisMap) as unknown as BodyInit,
          },
        ),
        e,
        testCtx,
      );
      expect(res.status).toBe(status);
      if (!attested) {
        expect(await problemDetail(res)).toContain("attestation");
      }
      const reservation = await readUnivocityInstanceReservation(e, instanceId);
      expect(reservation?.state).toBe(reservationState);
    },
  );

  // Request records hold PII and are kept only until redemption plus a
  // short TTL (ADR-0059; FOR-710). Genesis must not depend on one outliving
  // the token it produced.
  it.each([
    ["first redeem", 1, 0x73],
    ["re-redeem", 2, 0x74],
  ] as const)(
    "genesis with a token from an attested request's %s answers 201 once the request record is gone",
    async (_kind, redeems, addrByte) => {
      stubChain();
      const e = requestEnv();
      const chainBinding = {
        chainId: CHAIN,
        univocityAddr: addrByte.toString(16).repeat(20),
      };
      const { record, redeemCode } = await createOnboardRequest(e, {
        label: "scrubbed-request",
        chainBinding,
        contactEmail: "owner@example.test",
        ttlSec: 3600,
        attested: true,
      });
      await transitionPendingToApprovedCas(e, record.requestId);
      let token = "";
      for (let i = 0; i < redeems; i++) {
        const redeemed = await worker.fetch(
          new Request(
            `http://localhost/api/onboarding/requests/${record.requestId}/redeem`,
            {
              method: "POST",
              headers: { "Content-Type": "application/cbor" },
              body: encodeCborDeterministic(
                new Map<number, unknown>([[1, redeemCode]]),
              ) as unknown as BodyInit,
            },
          ),
          e,
          testCtx,
        );
        expect(redeemed.status).toBe(200);
        token = (
          decodeCborAsObject(new Uint8Array(await redeemed.arrayBuffer())) as {
            token: string;
          }
        ).token;
      }
      await e.R2_GRANTS.delete(onboardRequestR2Key(record.requestId));

      const genesisMap = validGenesisV2Es256CborMap({
        chainId: CHAIN,
        univocityAddr: new Uint8Array(20).fill(addrByte),
      });
      await seedGenesisChainIdentity(e, genesisMap);
      const res = await worker.fetch(
        new Request(
          `http://localhost/api/forest/${crypto.randomUUID()}/genesis`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/cbor",
            },
            body: encodeCborDeterministic(genesisMap) as unknown as BodyInit,
          },
        ),
        e,
        testCtx,
      );
      expect(res.status).toBe(201);
    },
  );
});
