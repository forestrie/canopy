/**
 * Coverage retrieval + standing delegate-key registration (FOR-390 phase C).
 *
 * Verifies that POST /api/delegations returns a WIDE certificate for a NARROW
 * seal window it covers (replacing exact certificate_key match), that the
 * issue response's onchainProof is rebuilt from the certificate's SIGNED range
 * — never the request range (review V1) — and that registering a standing
 * delegate key lets a certificate bound to it satisfy issue requests that
 * advertise a different (rotated) key.
 */

import { randomUUID } from "node:crypto";
import {
  decodeCborDeterministic,
  encodeCborDeterministic,
} from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
import { signOnchainDelegationEs256 } from "@forestrie/delegation-cose";
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

function authHeaders(extra?: HeadersInit): HeadersInit {
  return { Authorization: `Bearer ${TEST_TOKEN}`, ...extra };
}

/** Deterministic x/y matching {@link testDelegatedCoseKey}. */
function delegatedXY(seed: number): { x: Uint8Array; y: Uint8Array } {
  const x = new Uint8Array(32);
  const y = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    x[i] = (seed + i) & 0xff;
    y[i] = (seed + 100 + i) & 0xff;
  }
  return { x, y };
}

function decodeIssueResponse(bytes: Uint8Array): {
  certificate?: Uint8Array;
  onchainProof?: { mmrStart: number | bigint; mmrEnd: number | bigint };
} {
  const m = decodeCborDeterministic(bytes) as Map<string, unknown>;
  const proofMap = m.get("onchainProof") as Map<string, unknown> | undefined;
  return {
    certificate: m.get("certificate") as Uint8Array | undefined,
    onchainProof: proofMap
      ? {
          mmrStart: proofMap.get("mmrStart") as number | bigint,
          mmrEnd: proofMap.get("mmrEnd") as number | bigint,
        }
      : undefined,
  };
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

async function submitCert(opts: {
  logHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
  certificate: Uint8Array;
  issuedAt: number;
  expiresAt: number;
  onchainSignature?: Uint8Array;
}): Promise<Response> {
  return fetchWithDoRetry("http://localhost/api/delegations/certificate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      logId: opts.logHex32,
      mmrStart: opts.mmrStart,
      mmrEnd: opts.mmrEnd,
      delegatedPublicKey: bytesToBase64(opts.delegatedPublicKey),
      certificate: bytesToBase64(opts.certificate),
      issuedAt: opts.issuedAt,
      expiresAt: opts.expiresAt,
      ...(opts.onchainSignature
        ? { onchainSignature: bytesToBase64(opts.onchainSignature) }
        : {}),
    }),
  });
}

async function issue(opts: {
  logHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
}): Promise<Response> {
  return fetchWithDoRetry("http://localhost/api/delegations", {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/cbor",
      Accept: "application/cbor",
    }),
    body: encodeCborDeterministic({
      version: 1,
      logId: hex32ToWireLogIdBytes(opts.logHex32),
      mmrStart: opts.mmrStart,
      mmrEnd: opts.mmrEnd,
      algorithm: "ES256",
      delegatedPublicKey: opts.delegatedPublicKey,
      requestedTtlSeconds: 3600,
    }),
  });
}

/** Build + submit a wide ES256 advance certificate; returns its material. */
async function seedWideCert(opts: {
  logUuid: string;
  seed: number;
  mmrStart: number;
  mmrEnd: number;
  withOnchain?: boolean;
}) {
  const logHex32 = normalizeLogIdToHex32(opts.logUuid);
  const rootKeyPair = await generateTestRootKeyPair();
  const delegatedPublicKey = testDelegatedCoseKey(opts.seed);
  // Coverage retrieval filters out expired certs (expires_at > now), so the
  // advance cert must have a future expiry — unlike the fixture default which
  // is a fixed 2023 timestamp that the old exact-match path never checked.
  const issuedAt = 1_700_000_000;
  const expiresAt = 4_102_444_800; // 2100-01-01
  const material = await buildTestByokMaterial({
    rootKeyPair,
    logIdHex32: logHex32,
    mmrStart: opts.mmrStart,
    mmrEnd: opts.mmrEnd,
    delegatedPublicKey,
    issuedAt,
    expiresAt,
  });
  await registerEs256Root(opts.logUuid, material.x, material.y);

  let onchainSignature: Uint8Array | undefined;
  if (opts.withOnchain) {
    const { x, y } = delegatedXY(opts.seed);
    const proof = await signOnchainDelegationEs256(
      {
        logIdHex: logHex32,
        mmrStart: opts.mmrStart,
        mmrEnd: opts.mmrEnd,
        delegatedKeyX: x,
        delegatedKeyY: y,
      },
      rootKeyPair,
    );
    onchainSignature = proof.signature;
  }

  const putRes = await submitCert({
    logHex32,
    mmrStart: opts.mmrStart,
    mmrEnd: opts.mmrEnd,
    delegatedPublicKey,
    certificate: material.certificate,
    issuedAt: material.issuedAt,
    expiresAt: material.expiresAt,
    onchainSignature,
  });
  expect(putRes.status).toBe(200);
  return { logHex32, delegatedPublicKey };
}

describe("coverage retrieval (POST /api/delegations)", () => {
  it("returns a wide certificate for a narrow window it covers", async () => {
    const logUuid = randomUUID();
    const { logHex32, delegatedPublicKey } = await seedWideCert({
      logUuid,
      seed: 31,
      mmrStart: 0,
      mmrEnd: 16383,
    });

    // A narrow window strictly inside the stored [0, 16383] cert. Under exact
    // certificate_key match this missed (202); coverage retrieval hits.
    const res = await issue({
      logHex32,
      mmrStart: 5,
      mmrEnd: 7,
      delegatedPublicKey,
    });
    expect(res.status).toBe(200);
    const resp = decodeIssueResponse(new Uint8Array(await res.arrayBuffer()));
    expect(resp.certificate).toBeInstanceOf(Uint8Array);
  });

  it("does not return a certificate for a window outside its range", async () => {
    const logUuid = randomUUID();
    const { logHex32, delegatedPublicKey } = await seedWideCert({
      logUuid,
      seed: 33,
      mmrStart: 0,
      mmrEnd: 100,
    });

    const res = await issue({
      logHex32,
      mmrStart: 200,
      mmrEnd: 250,
      delegatedPublicKey,
    });
    expect(res.status).toBe(202);
  });

  it("rebuilds onchainProof from the certificate range, not the request (V1)", async () => {
    const logUuid = randomUUID();
    const { logHex32, delegatedPublicKey } = await seedWideCert({
      logUuid,
      seed: 37,
      mmrStart: 0,
      mmrEnd: 16383,
      withOnchain: true,
    });

    const res = await issue({
      logHex32,
      mmrStart: 100,
      mmrEnd: 200,
      delegatedPublicKey,
    });
    expect(res.status).toBe(200);
    const resp = decodeIssueResponse(new Uint8Array(await res.arrayBuffer()));
    expect(resp.onchainProof).toBeDefined();
    // The proof MUST carry the SIGNED range (0..16383), never the request
    // window (100..200) — else on-chain P256.verify fails at publishCheckpoint.
    expect(Number(resp.onchainProof!.mmrStart)).toBe(0);
    expect(Number(resp.onchainProof!.mmrEnd)).toBe(16383);
  });
});

describe("standing delegate-key registration (POST /api/sealer/delegate-keys)", () => {
  function futureNotAfter(): number {
    return 4_102_444_800; // 2100-01-01 — must be > real now, else retired at once
  }

  it("requires the app token", async () => {
    const res = await fetchWithDoRetry(
      "http://localhost/api/sealer/delegate-keys",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sealerId: "sealer-a", keys: [] }),
      },
    );
    expect(res.status).toBe(401);
  });

  it("registers keys and reports counts", async () => {
    const res = await fetchWithDoRetry(
      "http://localhost/api/sealer/delegate-keys",
      {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          sealerId: "sealer-a",
          keys: [
            {
              alg: "ES256",
              publicKey: bytesToBase64(testDelegatedCoseKey(61)),
              epoch: 2,
              notAfter: futureNotAfter(),
            },
          ],
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      registered: number;
      retired: number;
      shards: number;
    };
    expect(body.registered).toBe(1);
    expect(body.shards).toBeGreaterThanOrEqual(1);
  });

  it("lets a cert bound to a registered delegate key serve a rotated request", async () => {
    const logUuid = randomUUID();
    // Certificate bound to delegate key B (the standing key at issuance time).
    const { logHex32 } = await seedWideCert({
      logUuid,
      seed: 71, // key B
      mmrStart: 0,
      mmrEnd: 16383,
    });

    // A request advertising a DIFFERENT key A (post-rotation). Before the key
    // is registered, coverage cannot bind cert-B to this request → pending.
    const keyASeed = 81;
    const keyA = testDelegatedCoseKey(keyASeed);
    const missRes = await issue({
      logHex32,
      mmrStart: 5,
      mmrEnd: 7,
      delegatedPublicKey: keyA,
    });
    expect(missRes.status).toBe(202);

    // Register key B (the cert's bound key). Now the coverage JOIN matches it.
    const regRes = await fetchWithDoRetry(
      "http://localhost/api/sealer/delegate-keys",
      {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          sealerId: "sealer-a",
          keys: [
            {
              alg: "ES256",
              publicKey: bytesToBase64(testDelegatedCoseKey(71)),
              epoch: 2,
              notAfter: futureNotAfter(),
            },
          ],
        }),
      },
    );
    expect(regRes.status).toBe(200);

    const hitRes = await issue({
      logHex32,
      mmrStart: 5,
      mmrEnd: 7,
      delegatedPublicKey: keyA,
    });
    expect(hitRes.status).toBe(200);
    const resp = decodeIssueResponse(
      new Uint8Array(await hitRes.arrayBuffer()),
    );
    expect(resp.certificate).toBeInstanceOf(Uint8Array);
  });
});
