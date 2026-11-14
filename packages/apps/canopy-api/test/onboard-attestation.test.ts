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
  readOnboardTokenRecord,
} from "../src/payments/onboard-token-store.js";
import {
  readUnivocityInstanceReservation,
  requestHolder,
  reserveUnivocityInstance,
} from "../src/payments/instance-registry.js";
import {
  countNonTerminalRequestsForBinding,
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
import { onboardAttestationClaimKey } from "../src/onboarding/onboard-attestation-claim.js";
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

/**
 * Stands in for the marker key a winning create writes, for requests seeded
 * straight into the store. Admission checks only that the key is present.
 */
const TEST_CLAIM_KEY = "payments/used-attestations/test";

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
      // A refused replay creates no record, so replays cannot fill the
      // binding's pending cap against the owner.
      expect(await countNonTerminalRequestsForBinding(e, CHAIN, ADDR)).toBe(
        status === 201 ? 2 : 1,
      );
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
          attestationClaimKey: TEST_CLAIM_KEY,
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

// --- forfeit: requests and tokens created before single-use claims ---

describe("onboard requests created before single-use claims (forfeit)", () => {
  // Before single-use claims, create marked a request `attested: true` for
  // any verified attestation and published that attestation, so anyone could
  // replay it into an `attested: true` record. No record from before this
  // deploy proves ownership, attested or not. Only a record carrying the
  // claim key that create writes once its claim wins is ever admitted, and
  // only a token stamped from such a record passes genesis.
  const REQUEST_FORFEIT =
    "Request predates single-use attestations and is forfeit; create a new attested onboard request";
  const TOKEN_FORFEIT =
    "Onboard token predates single-use attestations and is forfeit; create a new attested onboard request";

  /** A pre-deploy record: no claim key, and `attested: true` or nothing. */
  type PreDeployKind = "unattested" | "attested";

  /** Write a request as the code before single-use claims wrote it. */
  async function seedPreDeploy(
    e: Env,
    addr: string,
    kind: PreDeployKind,
    reach: "pending" | "approved" | "redeemed" = "pending",
  ): Promise<{ requestId: string; redeemCode: string }> {
    const { record, redeemCode } = await createOnboardRequest(e, {
      label: "pre-deploy",
      chainBinding: { chainId: CHAIN, univocityAddr: addr },
      contactEmail: "owner@example.test",
      ttlSec: 3600,
      attestationClaimKey: TEST_CLAIM_KEY,
    });
    const preDeploy: Record<string, unknown> = { ...record };
    delete preDeploy.attestationClaimKey;
    if (kind === "attested") preDeploy.attested = true;
    await e.R2_GRANTS.put(
      onboardRequestR2Key(record.requestId),
      JSON.stringify(preDeploy),
    );
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

  function postRedeem(
    e: Env,
    requestId: string,
    redeemCode: string,
  ): Promise<Response> {
    return worker.fetch(
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
  }

  function postApprove(e: Env, requestId: string): Promise<Response> {
    return worker.fetch(
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
  }

  /** Seed the chain identity for the binding and post genesis with `token`. */
  async function postGenesis(
    e: Env,
    addrByte: number,
    token: string,
  ): Promise<Response> {
    const genesisMap = validGenesisV2Es256CborMap({
      chainId: CHAIN,
      univocityAddr: new Uint8Array(20).fill(addrByte),
    });
    await seedGenesisChainIdentity(e, genesisMap);
    return worker.fetch(
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
  }

  // Whatever state a pre-deploy record reached, it is never admitted. The
  // redeemed rows are re-redeem, which reissues a token.
  it.each([
    ["unattested", "pending", "c".repeat(40)],
    ["unattested", "approved", "d".repeat(40)],
    ["unattested", "redeemed", "e".repeat(40)],
    ["attested", "pending", "c1".repeat(20)],
    ["attested", "approved", "d1".repeat(20)],
    ["attested", "redeemed", "e1".repeat(20)],
  ] as const)(
    "redeem of a pre-deploy %s %s record is refused (409), mints nothing",
    async (kind, reach, addr) => {
      const e = requestEnv();
      const { requestId, redeemCode } = await seedPreDeploy(
        e,
        addr,
        kind,
        reach,
      );
      const res = await postRedeem(e, requestId, redeemCode);
      expect(res.status).toBe(409);
      expect(await problemDetail(res)).toBe(REQUEST_FORFEIT);
      const tokens = await listOnboardTokens(e);
      expect(tokens.filter((t) => t.requestId === requestId)).toEqual([]);
      const instanceId = tryUnivocityInstanceIdFromChainBinding({
        chainId: CHAIN,
        univocityAddr: addr,
      });
      expect(await readUnivocityInstanceReservation(e, instanceId!)).toBeNull();
    },
  );

  it.each([
    ["unattested", "f".repeat(40)],
    ["attested", "f1".repeat(20)],
  ] as const)(
    "ops approve of a pre-deploy %s pending record is refused (409)",
    async (kind, addr) => {
      const e = requestEnv();
      const { requestId } = await seedPreDeploy(e, addr, kind);
      const res = await postApprove(e, requestId);
      expect(res.status).toBe(409);
      expect(await problemDetail(res)).toBe(REQUEST_FORFEIT);
      expect((await readOnboardRequest(e, requestId))?.status).toBe("pending");
    },
  );

  // A pre-deploy record can never be admitted, so it must not hold one of
  // the binding's pending slots (cap 3) against the owner's new create.
  it.each([
    ["pre-deploy unattested", 201, "unattested", "1".repeat(40)],
    ["pre-deploy attested", 201, "attested", "4".repeat(40)],
    ["claimed", 409, "claimed", "2".repeat(40)],
  ] as const)(
    "three %s pending records, then an attested create answers %i",
    async (_what, status, kind, addr) => {
      stubChain();
      const e = requestEnv();
      for (let i = 0; i < 3; i++) {
        if (kind === "claimed") {
          await createOnboardRequest(e, {
            label: "filler",
            chainBinding: { chainId: CHAIN, univocityAddr: addr },
            contactEmail: "owner@example.test",
            ttlSec: 3600,
            attestationClaimKey: TEST_CLAIM_KEY,
          });
        } else {
          await seedPreDeploy(e, addr, kind);
        }
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

  // A token redeemed before this deploy has no stamp and stays active until
  // its expiry. Genesis must refuse it, or it sets the instance root (P14).
  it.each([
    ["a claimed request, stamped", 201, "claimed", 0x71, "registered"],
    ["a pre-deploy unattested request", 403, "unattested", 0x72, "reserved"],
    ["a pre-deploy attested request", 403, "attested", 0x75, "reserved"],
  ] as const)(
    "genesis with a token redeemed from %s answers %i",
    async (_what, status, kind, addrByte, reservationState) => {
      stubChain();
      const e = requestEnv();
      const chainBinding = {
        chainId: CHAIN,
        univocityAddr: addrByte.toString(16).repeat(20),
      };
      let requestId: string;
      if (kind === "claimed") {
        const { record } = await createOnboardRequest(e, {
          label: "claimed-token",
          chainBinding,
          contactEmail: "owner@example.test",
          ttlSec: 3600,
          attestationClaimKey: TEST_CLAIM_KEY,
        });
        requestId = record.requestId;
        await transitionPendingToApprovedCas(e, requestId);
        await transitionApprovedToRedeemedCas(e, requestId);
      } else {
        ({ requestId } = await seedPreDeploy(
          e,
          chainBinding.univocityAddr,
          kind,
          "redeemed",
        ));
      }
      // Redeem stamps the token it mints from a claimed request; a token
      // from before this deploy has no stamp at all.
      const minted = await mintOnboardToken(e, {
        label: "token",
        requestId,
        chainBinding,
        admittedBy: "ops",
        attested: kind === "claimed" ? true : undefined,
      });
      const instanceId = tryUnivocityInstanceIdFromChainBinding(chainBinding)!;
      await reserveUnivocityInstance(e, instanceId, requestHolder(requestId));

      const res = await postGenesis(e, addrByte, minted.token);
      expect(res.status).toBe(status);
      if (status === 403) {
        expect(await problemDetail(res)).toBe(TOKEN_FORFEIT);
      }
      const reservation = await readUnivocityInstanceReservation(e, instanceId);
      expect(reservation?.state).toBe(reservationState);
    },
  );

  it("a fresh create is marked, approved, redeemed to a stamped token, and genesis answers 201", async () => {
    stubChain();
    const e = requestEnv();
    const addrByte = 0x76;
    const addr = addrByte.toString(16).repeat(20);
    const now = Math.floor(Date.now() / 1000);
    const attestation = buildAttestation(COSE_ALG_ES256, {
      univocityAddr: addr,
      iat: now - 60,
      exp: now + 3600,
    });
    const fields = baseFields(addr);
    fields.set(7, attestation);
    const created = await postCreate(e, fields);
    expect(created.status).toBe(201);
    const { requestId, redeemCode } = decodeCborAsObject(
      new Uint8Array(await created.arrayBuffer()),
    ) as { requestId: string; redeemCode: string };
    expect((await readOnboardRequest(e, requestId))?.attestationClaimKey).toBe(
      await onboardAttestationClaimKey(attestation),
    );

    expect((await postApprove(e, requestId)).status).toBe(200);
    const redeemed = await postRedeem(e, requestId, redeemCode);
    expect(redeemed.status).toBe(200);
    const { token, ref } = decodeCborAsObject(
      new Uint8Array(await redeemed.arrayBuffer()),
    ) as { token: string; ref: string };
    expect((await readOnboardTokenRecord(e, ref))?.attested).toBe(true);

    expect((await postGenesis(e, addrByte, token)).status).toBe(201);
  });

  // Request records hold PII and are kept only until redemption plus a
  // short TTL (ADR-0059; FOR-710). Genesis must not depend on one outliving
  // the token it produced.
  it.each([
    ["first redeem", 1, 0x73],
    ["re-redeem", 2, 0x74],
  ] as const)(
    "genesis with a token from a claimed request's %s answers 201 once the request record is gone",
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
        attestationClaimKey: TEST_CLAIM_KEY,
      });
      await transitionPendingToApprovedCas(e, record.requestId);
      let token = "";
      for (let i = 0; i < redeems; i++) {
        const redeemed = await postRedeem(e, record.requestId, redeemCode);
        expect(redeemed.status).toBe(200);
        token = (
          decodeCborAsObject(new Uint8Array(await redeemed.arrayBuffer())) as {
            token: string;
          }
        ).token;
      }
      await e.R2_GRANTS.delete(onboardRequestR2Key(record.requestId));

      expect((await postGenesis(e, addrByte, token)).status).toBe(201);
    },
  );
});
