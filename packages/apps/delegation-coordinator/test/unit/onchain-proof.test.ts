/**
 * BYOK on-chain delegation proof flow (plan-2607-10): a KS256-root wallet
 * submits `onchainSignature` alongside the delegation certificate; the
 * coordinator validates it against the stored root and returns `onchainProof`
 * from POST /api/delegations with CBOR keys matching arbor
 * `delegationcert.OnchainDelegationProof`.
 */

import { decode, encode } from "cbor-x";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  buildDelegationCertificateKs256,
  signOnchainDelegationKs256,
} from "@forestrie/delegation-cose";
import { bytesToBase64 } from "../../src/encoding.js";
import {
  hex32ToWireLogIdBytes,
  normalizeLogIdToHex32,
} from "../../src/log-id.js";
import { testDelegatedCoseKey } from "./byok-material-fixture.js";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";

const TEST_TOKEN = "test-coordinator-token";

// Anvil dev account 0.
const ROOT_PRIVATE_KEY_HEX =
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function authHeaders(extra?: HeadersInit): HeadersInit {
  return {
    Authorization: `Bearer ${TEST_TOKEN}`,
    ...extra,
  };
}

function rootAddress(privateKeyHex: string): Uint8Array {
  const pub = secp256k1.getPublicKey(privateKeyHex, false);
  return keccak_256(pub.slice(1)).slice(-20);
}

function cborBody(value: unknown): Uint8Array {
  const encoded = encode(value);
  return encoded instanceof Uint8Array
    ? encoded
    : new Uint8Array(encoded as ArrayLike<number>);
}

/** Extract deterministic x/y used by {@link testDelegatedCoseKey}. */
function delegatedXY(seed: number): { x: Uint8Array; y: Uint8Array } {
  const x = new Uint8Array(32);
  const y = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    x[i] = (seed + i) & 0xff;
    y[i] = (seed + 100 + i) & 0xff;
  }
  return { x, y };
}

async function registerKs256Root(
  logUuid: string,
  address: Uint8Array,
): Promise<void> {
  const res = await fetchWithDoRetry(
    `http://localhost/api/logs/${logUuid}/public-root`,
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ alg: -65799, key: bytesToBase64(address) }),
    },
  );
  expect(res.status).toBe(200);
}

interface CertSubmission {
  logHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
  issuedAt: number;
  expiresAt: number;
}

async function buildKs256Submission(opts: {
  logUuid: string;
  seed: number;
  mmrStart: number;
  mmrEnd: number;
}): Promise<CertSubmission & { certificate: Uint8Array }> {
  const logHex32 = normalizeLogIdToHex32(opts.logUuid);
  const delegatedPublicKey = testDelegatedCoseKey(opts.seed);
  const issuedAt = 1_700_000_000;
  const expiresAt = issuedAt + 3600;
  const certificate = await buildDelegationCertificateKs256(
    {
      logIdHex32: logHex32,
      mmrStart: opts.mmrStart,
      mmrEnd: opts.mmrEnd,
      delegatedPublicKeyCbor: delegatedPublicKey,
      issuedAt,
      expiresAt,
    },
    rootAddress(ROOT_PRIVATE_KEY_HEX),
    ROOT_PRIVATE_KEY_HEX,
  );
  return {
    logHex32,
    mmrStart: opts.mmrStart,
    mmrEnd: opts.mmrEnd,
    delegatedPublicKey,
    issuedAt,
    expiresAt,
    certificate,
  };
}

async function submitCertificate(
  sub: CertSubmission & { certificate: Uint8Array },
  onchainSignature?: Uint8Array,
): Promise<Response> {
  return fetchWithDoRetry("http://localhost/api/delegations/certificate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      logId: sub.logHex32,
      mmrStart: sub.mmrStart,
      mmrEnd: sub.mmrEnd,
      delegatedPublicKey: bytesToBase64(sub.delegatedPublicKey),
      certificate: bytesToBase64(sub.certificate),
      issuedAt: sub.issuedAt,
      expiresAt: sub.expiresAt,
      ...(onchainSignature
        ? { onchainSignature: bytesToBase64(onchainSignature) }
        : {}),
    }),
  });
}

async function issueDelegation(sub: CertSubmission): Promise<Response> {
  return fetchWithDoRetry("http://localhost/api/delegations", {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/cbor",
      Accept: "application/cbor",
    }),
    body: cborBody({
      version: 1,
      logId: hex32ToWireLogIdBytes(sub.logHex32),
      mmrStart: sub.mmrStart,
      mmrEnd: sub.mmrEnd,
      algorithm: "ES256",
      delegatedPublicKey: sub.delegatedPublicKey,
      requestedTtlSeconds: 3600,
    }),
  });
}

interface OnchainProofWire {
  protectedHeader: Uint8Array;
  delegationKey: Uint8Array;
  mmrStart: number | bigint;
  mmrEnd: number | bigint;
  signature: Uint8Array;
}

describe("BYOK on-chain delegation proof", () => {
  it("accepts onchainSignature and returns onchainProof from issue", async () => {
    const logUuid = "41234567-89ab-cdef-0123-456789abcdef";
    const address = rootAddress(ROOT_PRIVATE_KEY_HEX);
    await registerKs256Root(logUuid, address);

    const sub = await buildKs256Submission({
      logUuid,
      seed: 7,
      mmrStart: 0,
      mmrEnd: 16383,
    });
    const { x, y } = delegatedXY(7);
    const proof = signOnchainDelegationKs256(
      {
        logIdHex: sub.logHex32,
        mmrStart: sub.mmrStart,
        mmrEnd: sub.mmrEnd,
        delegatedKeyX: x,
        delegatedKeyY: y,
      },
      ROOT_PRIVATE_KEY_HEX,
    );

    const putRes = await submitCertificate(sub, proof.signature);
    expect(putRes.status).toBe(200);

    const issueRes = await issueDelegation(sub);
    expect(issueRes.status).toBe(200);
    const resp = decode(new Uint8Array(await issueRes.arrayBuffer())) as {
      certificate?: Uint8Array;
      onchainProof?: OnchainProofWire;
    };
    expect(resp.certificate).toBeInstanceOf(Uint8Array);
    expect(resp.onchainProof).toBeDefined();
    const wire = resp.onchainProof!;
    expect(Array.from(wire.protectedHeader)).toEqual(
      Array.from(proof.protectedHeader),
    );
    expect(Array.from(wire.delegationKey)).toEqual(
      Array.from(proof.delegationKey),
    );
    expect(Number(wire.mmrStart)).toBe(sub.mmrStart);
    expect(Number(wire.mmrEnd)).toBe(sub.mmrEnd);
    expect(Array.from(wire.signature)).toEqual(Array.from(proof.signature));
  });

  it("rejects an onchainSignature by a different key with 400", async () => {
    const logUuid = "51234567-89ab-cdef-0123-456789abcdef";
    const address = rootAddress(ROOT_PRIVATE_KEY_HEX);
    await registerKs256Root(logUuid, address);

    const sub = await buildKs256Submission({
      logUuid,
      seed: 9,
      mmrStart: 0,
      mmrEnd: 16383,
    });
    const { x, y } = delegatedXY(9);
    // Anvil dev account 1 — not the registered root.
    const wrongKey =
      "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const proof = signOnchainDelegationKs256(
      {
        logIdHex: sub.logHex32,
        mmrStart: sub.mmrStart,
        mmrEnd: sub.mmrEnd,
        delegatedKeyX: x,
        delegatedKeyY: y,
      },
      wrongKey,
    );

    const putRes = await submitCertificate(sub, proof.signature);
    expect(putRes.status).toBe(400);

    // Certificate must not be stored with a proof: issue stays pending.
    const issueRes = await issueDelegation(sub);
    expect(issueRes.status).toBe(202);
  });

  it("still stores and returns the certificate without onchainSignature", async () => {
    const logUuid = "61234567-89ab-cdef-0123-456789abcdef";
    const address = rootAddress(ROOT_PRIVATE_KEY_HEX);
    await registerKs256Root(logUuid, address);

    const sub = await buildKs256Submission({
      logUuid,
      seed: 11,
      mmrStart: 0,
      mmrEnd: 16383,
    });

    const putRes = await submitCertificate(sub);
    expect(putRes.status).toBe(200);

    const issueRes = await issueDelegation(sub);
    expect(issueRes.status).toBe(200);
    const resp = decode(new Uint8Array(await issueRes.arrayBuffer())) as {
      certificate?: Uint8Array;
      onchainProof?: unknown;
    };
    expect(resp.certificate).toBeInstanceOf(Uint8Array);
    expect(resp.onchainProof).toBeUndefined();
  });
});
