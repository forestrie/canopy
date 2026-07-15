/**
 * Pre-sign-before-existence onboarding (ADR-0053 / plan-2607-23 Part C).
 *
 * Proves the coordinator serves an advance delegation certificate for a child log
 * that has ONLY had its public root registered — exactly what canopy-api's
 * `POST /api/forest/{childLogId}/prepare` does — with the log NOT otherwise
 * "created"/sequenced. The coordinator has no notion of log creation; the sole gate
 * on certificate submission (`handlePutCertificate`) is a registered public root,
 * and coverage retrieval (`POST /api/delegations`) is permissive. So:
 *
 *  1. Without a public root, cert submission 404s (proves the gate).
 *  2. Register the child public root (the prepare forward: `POST
 *     /api/logs/{id}/public-root`) → submit a WIDE advance cert → coverage
 *     retrieval returns it for a narrow covering seal window. No sequencing, no
 *     on-chain existence.
 */

import { randomUUID } from "node:crypto";
import {
  decodeCborDeterministic,
  encodeCborDeterministic,
} from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
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

/** Register a child public root — the exact call canopy-api prepare forwards. */
async function registerChildPublicRoot(
  logUuid: string,
  x: Uint8Array,
  y: Uint8Array,
): Promise<Response> {
  return fetchWithDoRetry(`http://localhost/api/logs/${logUuid}/public-root`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      alg: "ES256",
      x: bytesToBase64(x),
      y: bytesToBase64(y),
    }),
  });
}

async function submitCert(opts: {
  logHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
  certificate: Uint8Array;
  issuedAt: number;
  expiresAt: number;
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

function decodeIssueCertificate(bytes: Uint8Array): Uint8Array | undefined {
  const m = decodeCborDeterministic(bytes) as Map<string, unknown>;
  return m.get("certificate") as Uint8Array | undefined;
}

/** Build a wide advance certificate + its bound owner (root) key material. */
async function buildAdvanceCert(opts: {
  logHex32: string;
  seed: number;
  mmrStart: number;
  mmrEnd: number;
}) {
  const rootKeyPair = await generateTestRootKeyPair();
  const delegatedPublicKey = testDelegatedCoseKey(opts.seed);
  const material = await buildTestByokMaterial({
    rootKeyPair,
    logIdHex32: opts.logHex32,
    mmrStart: opts.mmrStart,
    mmrEnd: opts.mmrEnd,
    delegatedPublicKey,
    issuedAt: 1_700_000_000,
    expiresAt: 4_102_444_800, // 2100-01-01 — future so coverage retrieval serves it
  });
  return { material, delegatedPublicKey };
}

describe("pre-sign before existence (ADR-0053 prepare onboarding)", () => {
  it("404s certificate submission until the child public root is registered", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const { material, delegatedPublicKey } = await buildAdvanceCert({
      logHex32,
      seed: 211,
      mmrStart: 0,
      mmrEnd: 16383,
    });

    // No public root yet (log never prepared/created): the only gate rejects.
    const before = await submitCert({
      logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
      certificate: material.certificate,
      issuedAt: material.issuedAt,
      expiresAt: material.expiresAt,
    });
    expect(before.status).toBe(404);
  });

  it("serves a pre-signed advance cert for a child that only had its public root registered", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const { material, delegatedPublicKey } = await buildAdvanceCert({
      logHex32,
      seed: 213,
      mmrStart: 0,
      mmrEnd: 16383,
    });

    // Step 1 — prepare: register the child's public root (owner key). This is the
    // ONLY onboarding step; the log is never created/sequenced.
    const rootRes = await registerChildPublicRoot(
      logUuid,
      material.x,
      material.y,
    );
    expect(rootRes.status).toBe(200);

    // Step 2 — pre-sign: submit the wide advance certificate. Accepted now that the
    // public root gate is satisfied.
    const putRes = await submitCert({
      logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
      certificate: material.certificate,
      issuedAt: material.issuedAt,
      expiresAt: material.expiresAt,
    });
    expect(putRes.status).toBe(200);

    // Step 3 — first seal: coverage retrieval returns the pre-signed cert for a
    // narrow window strictly inside the signed [0, 16383] range.
    const issued = await issue({
      logHex32,
      mmrStart: 3,
      mmrEnd: 9,
      delegatedPublicKey,
    });
    expect(issued.status).toBe(200);
    const cert = decodeIssueCertificate(
      new Uint8Array(await issued.arrayBuffer()),
    );
    expect(cert).toBeInstanceOf(Uint8Array);
  });
});
