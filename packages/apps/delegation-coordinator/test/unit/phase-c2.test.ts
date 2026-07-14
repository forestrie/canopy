/**
 * Phase C-2 (FOR-390): public GET /delegation (C2), the standing pending entry
 * (C3), and submit-time validation — advance onchainSignature requirement +
 * staleness + covered-pending cleanup (C5).
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signOnchainDelegationEs256 } from "@forestrie/delegation-cose";
import { bytesToBase64 } from "../../src/encoding.js";
import { normalizeLogIdToHex32 } from "../../src/log-id.js";
import {
  buildTestByokMaterial,
  generateTestRootKeyPair,
  testDelegatedCoseKey,
} from "./byok-material-fixture.js";
import { delegateKeyEntryWithVoucher } from "./registrar-voucher-fixture.js";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";

const TEST_TOKEN = "test-coordinator-token";
const FAR_FUTURE = 4_102_444_800; // 2100-01-01

function authHeaders(extra?: HeadersInit): HeadersInit {
  return { Authorization: `Bearer ${TEST_TOKEN}`, ...extra };
}

function delegatedXY(seed: number): { x: Uint8Array; y: Uint8Array } {
  const x = new Uint8Array(32);
  const y = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    x[i] = (seed + i) & 0xff;
    y[i] = (seed + 100 + i) & 0xff;
  }
  return { x, y };
}

async function registerEs256Root(
  logUuid: string,
  x: Uint8Array,
  y: Uint8Array,
) {
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

async function registerDelegateKey(
  seed: number,
  epoch = 2,
  notAfter = FAR_FUTURE,
) {
  const res = await fetchWithDoRetry(
    "http://localhost/api/sealer/delegate-keys",
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        sealerId: "sealer-a",
        keys: [
          await delegateKeyEntryWithVoucher({
            sealerId: "sealer-a",
            publicKey: testDelegatedCoseKey(seed),
            epoch,
            notAfter,
          }),
        ],
      }),
    },
  );
  expect(res.status).toBe(200);
}

async function submitCert(opts: {
  logHex32: string;
  rootKeyPair: CryptoKeyPair;
  seed: number;
  mmrStart: number;
  mmrEnd: number;
  issuedAt: number;
  expiresAt: number;
  withOnchain?: boolean;
}): Promise<Response> {
  const delegatedPublicKey = testDelegatedCoseKey(opts.seed);
  const material = await buildTestByokMaterial({
    rootKeyPair: opts.rootKeyPair,
    logIdHex32: opts.logHex32,
    mmrStart: opts.mmrStart,
    mmrEnd: opts.mmrEnd,
    delegatedPublicKey,
    issuedAt: opts.issuedAt,
    expiresAt: opts.expiresAt,
  });
  let onchainSignature: Uint8Array | undefined;
  if (opts.withOnchain) {
    const { x, y } = delegatedXY(opts.seed);
    const proof = await signOnchainDelegationEs256(
      {
        logIdHex: opts.logHex32,
        mmrStart: opts.mmrStart,
        mmrEnd: opts.mmrEnd,
        delegatedKeyX: x,
        delegatedKeyY: y,
      },
      opts.rootKeyPair,
    );
    onchainSignature = proof.signature;
  }
  return fetchWithDoRetry("http://localhost/api/delegations/certificate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      logId: opts.logHex32,
      mmrStart: opts.mmrStart,
      mmrEnd: opts.mmrEnd,
      delegatedPublicKey: bytesToBase64(delegatedPublicKey),
      certificate: bytesToBase64(material.certificate),
      issuedAt: opts.issuedAt,
      expiresAt: opts.expiresAt,
      ...(onchainSignature
        ? { onchainSignature: bytesToBase64(onchainSignature) }
        : {}),
    }),
  });
}

describe("C2 — public GET /api/logs/{logId}/delegation", () => {
  it("404 when no certificate exists", async () => {
    const logUuid = randomUUID();
    const res = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/delegation`,
      { method: "GET" },
    );
    expect(res.status).toBe(404);
  });

  it("returns the current certificate (public, no auth)", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const rootKeyPair = await generateTestRootKeyPair();
    const material = await buildTestByokMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey: testDelegatedCoseKey(41),
      issuedAt: 1_700_000_000,
      expiresAt: FAR_FUTURE,
    });
    await registerEs256Root(logUuid, material.x, material.y);
    const put = await submitCert({
      logHex32,
      rootKeyPair,
      seed: 41,
      mmrStart: 0,
      mmrEnd: 16383,
      issuedAt: 1_700_000_000,
      expiresAt: FAR_FUTURE,
    });
    expect(put.status).toBe(200);

    const res = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/delegation`,
      { method: "GET" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      certificate: string;
      mmrStart: number;
      mmrEnd: number;
      expiresAt: number;
      delegatedPublicKey: string | null;
    };
    expect(body.mmrStart).toBe(0);
    expect(body.mmrEnd).toBe(16383);
    expect(body.expiresAt).toBe(FAR_FUTURE);
    expect(typeof body.certificate).toBe("string");
    expect(body.delegatedPublicKey).toBe(
      bytesToBase64(testDelegatedCoseKey(41)),
    );
  });
});

describe("C3 — standing entry in pending-delegation", () => {
  it("absent without a public root or a registered delegate key", async () => {
    const logUuid = randomUUID();
    const res = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/pending-delegation`,
      { method: "GET" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toHaveLength(0);
  });

  it("present (window-less) once a root + delegate key are registered", async () => {
    const logUuid = randomUUID();
    const rootKeyPair = await generateTestRootKeyPair();
    const material = await buildTestByokMaterial({
      rootKeyPair,
      logIdHex32: normalizeLogIdToHex32(logUuid),
      mmrStart: 0,
      mmrEnd: 1,
      delegatedPublicKey: testDelegatedCoseKey(51),
    });
    await registerEs256Root(logUuid, material.x, material.y);
    // Highest epoch so this key deterministically wins "current" under the
    // shared test store (delegate keys fan out to every shard).
    await registerDelegateKey(51, 100000);

    const res = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/pending-delegation`,
      { method: "GET" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{
        delegatedPublicKey: string;
        suggestedTtlSeconds?: number;
        mmrStart?: number;
      }>;
    };
    const standing = body.entries.find(
      (e) => e.suggestedTtlSeconds !== undefined,
    );
    expect(standing).toBeDefined();
    expect(standing!.mmrStart).toBeUndefined(); // window-less
    expect(standing!.delegatedPublicKey).toBe(
      bytesToBase64(testDelegatedCoseKey(51)),
    );
  });
});

describe("C5 — submit validation + staleness", () => {
  it("rejects an advance cert without onchainSignature (400)", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const rootKeyPair = await generateTestRootKeyPair();
    const material = await buildTestByokMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart: 0,
      mmrEnd: 100,
      delegatedPublicKey: testDelegatedCoseKey(61),
    });
    await registerEs256Root(logUuid, material.x, material.y);
    await registerDelegateKey(61); // makes seed-61 an advance key

    const res = await submitCert({
      logHex32,
      rootKeyPair,
      seed: 61,
      mmrStart: 0,
      mmrEnd: 100,
      issuedAt: 1_700_000_000,
      expiresAt: FAR_FUTURE,
      withOnchain: false,
    });
    expect(res.status).toBe(400);
  });

  it("accepts the same advance cert once onchainSignature is present", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const rootKeyPair = await generateTestRootKeyPair();
    const material = await buildTestByokMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart: 0,
      mmrEnd: 100,
      delegatedPublicKey: testDelegatedCoseKey(63),
    });
    await registerEs256Root(logUuid, material.x, material.y);
    await registerDelegateKey(63);

    const res = await submitCert({
      logHex32,
      rootKeyPair,
      seed: 63,
      mmrStart: 0,
      mmrEnd: 100,
      issuedAt: 1_700_000_000,
      expiresAt: FAR_FUTURE,
      withOnchain: true,
    });
    expect(res.status).toBe(200);
  });

  it("rejects an already-expiring cert (409)", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const rootKeyPair = await generateTestRootKeyPair();
    const now = Math.floor(Date.now() / 1000);
    const material = await buildTestByokMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart: 0,
      mmrEnd: 100,
      delegatedPublicKey: testDelegatedCoseKey(65),
      issuedAt: now - 10,
      expiresAt: now + 30, // within the now+60 stale window
    });
    await registerEs256Root(logUuid, material.x, material.y);

    const res = await submitCert({
      logHex32,
      rootKeyPair,
      seed: 65,
      mmrStart: 0,
      mmrEnd: 100,
      issuedAt: now - 10,
      expiresAt: now + 30,
    });
    expect(res.status).toBe(409);
  });

  it("rejects a cert superseded by a wider, longer-lived one (409)", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const rootKeyPair = await generateTestRootKeyPair();
    const material = await buildTestByokMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart: 0,
      mmrEnd: 1000,
      delegatedPublicKey: testDelegatedCoseKey(67),
    });
    await registerEs256Root(logUuid, material.x, material.y);

    const wide = await submitCert({
      logHex32,
      rootKeyPair,
      seed: 67,
      mmrStart: 0,
      mmrEnd: 1000,
      issuedAt: 1_700_000_000,
      expiresAt: FAR_FUTURE,
    });
    expect(wide.status).toBe(200);

    // A narrower cert (same key) with equal expiry is superseded by the wide one.
    const narrow = await submitCert({
      logHex32,
      rootKeyPair,
      seed: 67,
      mmrStart: 0,
      mmrEnd: 100,
      issuedAt: 1_700_000_000,
      expiresAt: FAR_FUTURE,
    });
    expect(narrow.status).toBe(409);
  });
});
