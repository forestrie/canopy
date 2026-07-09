/**
 * BYOK on-chain delegation proof flow (plan-2607-10): the root submits
 * `onchainSignature` alongside the delegation certificate; the coordinator
 * validates it against the stored public root (KS256 wallet address or ES256
 * P-256 key — uniform across variants) and returns `onchainProof` from
 * POST /api/delegations with CBOR keys matching arbor
 * `delegationcert.OnchainDelegationProof`.
 */

import { randomUUID } from "node:crypto";
import { decode, encode } from "cbor-x";
import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  buildDelegationCertificateKs256,
  signOnchainDelegationEs256,
  signOnchainDelegationKs256,
} from "@forestrie/delegation-cose";
import { bytesToBase64 } from "../../src/encoding.js";
import {
  hex32ToWireLogIdBytes,
  normalizeLogIdToHex32,
} from "../../src/log-id.js";
import {
  buildTestByokMaterial,
  generateTestRootKeyPair,
  testDelegatedCoseKey,
} from "./byok-material-fixture.js";
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

async function registerEs256Root(
  logUuid: string,
  x: Uint8Array,
  y: Uint8Array,
): Promise<void> {
  const res = await fetchWithDoRetry(
    `http://localhost/api/logs/${logUuid}/public-root`,
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        alg: "ES256",
        x: bytesToBase64(x),
        y: bytesToBase64(y),
      }),
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
    const logUuid = randomUUID();
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
    const logUuid = randomUUID();
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

  it("accepts an ES256 onchainSignature and returns the ES256-header proof", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const rootKeyPair = await generateTestRootKeyPair();
    const seed = 13;
    const delegatedPublicKey = testDelegatedCoseKey(seed);
    const material = await buildTestByokMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
    });
    await registerEs256Root(logUuid, material.x, material.y);

    const { x, y } = delegatedXY(seed);
    const proof = await signOnchainDelegationEs256(
      {
        logIdHex: logHex32,
        mmrStart: 0,
        mmrEnd: 16383,
        delegatedKeyX: x,
        delegatedKeyY: y,
      },
      rootKeyPair,
    );

    const sub = {
      logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
      issuedAt: material.issuedAt,
      expiresAt: material.expiresAt,
      certificate: material.certificate,
    };
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
    // ES256 protected header {1: -7}.
    expect(Array.from(wire.protectedHeader)).toEqual([0xa1, 0x01, 0x26]);
    expect(Array.from(wire.delegationKey)).toEqual(
      Array.from(proof.delegationKey),
    );
    expect(Number(wire.mmrStart)).toBe(0);
    expect(Number(wire.mmrEnd)).toBe(16383);
    expect(wire.signature.length).toBe(64);
    expect(Array.from(wire.signature)).toEqual(Array.from(proof.signature));
  });

  it("rejects an ES256 onchainSignature by a different key with 400", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const rootKeyPair = await generateTestRootKeyPair();
    const otherKeyPair = await generateTestRootKeyPair();
    const seed = 17;
    const delegatedPublicKey = testDelegatedCoseKey(seed);
    const material = await buildTestByokMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
    });
    await registerEs256Root(logUuid, material.x, material.y);

    const { x, y } = delegatedXY(seed);
    const proof = await signOnchainDelegationEs256(
      {
        logIdHex: logHex32,
        mmrStart: 0,
        mmrEnd: 16383,
        delegatedKeyX: x,
        delegatedKeyY: y,
      },
      otherKeyPair,
    );

    const sub = {
      logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
      issuedAt: material.issuedAt,
      expiresAt: material.expiresAt,
      certificate: material.certificate,
    };
    const putRes = await submitCertificate(sub, proof.signature);
    expect(putRes.status).toBe(400);

    const issueRes = await issueDelegation(sub);
    expect(issueRes.status).toBe(202);
  });

  it("still stores and returns the certificate without onchainSignature", async () => {
    const logUuid = randomUUID();
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

  it("omits onchainProof when the public root alg rotates after submission", async () => {
    // Signature was validated against the KS256 root at submit time; a later
    // ES256 root replace must not rebuild the proof under the new header.
    const logUuid = randomUUID();
    const address = rootAddress(ROOT_PRIVATE_KEY_HEX);
    await registerKs256Root(logUuid, address);

    const sub = await buildKs256Submission({
      logUuid,
      seed: 19,
      mmrStart: 0,
      mmrEnd: 16383,
    });
    const { x, y } = delegatedXY(19);
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

    const es256Root = await generateTestRootKeyPair();
    const material = await buildTestByokMaterial({
      rootKeyPair: es256Root,
      logIdHex32: sub.logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey: sub.delegatedPublicKey,
    });
    await registerEs256Root(logUuid, material.x, material.y);

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
