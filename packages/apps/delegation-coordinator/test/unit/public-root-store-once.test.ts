/**
 * The coordinator stores a log's public root once
 * ([devdocs ADR-0075](https://github.com/forestrie/devdocs/blob/main/adr/adr-0075-sec-child-root-claimed-once.md)
 * decision 3). canopy-api forwards a root only after univocity has claimed
 * the log, so a second forward is either the same claim again (same key: 200)
 * or a squat (different key: 409). A root forwarded by `prepare` carries the
 * univocity reservation's `expiresAt`; once that passes, the root and the
 * delegation certificates stored under it are absent, so another owner's
 * claim can register. The forward made when create commits the grant is
 * permanent.
 */

import { randomUUID } from "node:crypto";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../../src/encoding.js";
import { getStoreStubForLogId } from "../../src/handlers/handler.js";
import { normalizeLogIdToHex32 } from "../../src/log-id.js";
import type { Env } from "../../src/env.js";
import {
  buildTestByokMaterial,
  generateTestRootKeyPair,
  testDelegatedCoseKey,
} from "./byok-material-fixture.js";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";

const TEST_TOKEN = "test-coordinator-token";
const FAR_FUTURE = 4_102_444_800; // 2100-01-01

function postRoot(
  logUuid: string,
  root: { x: Uint8Array; y: Uint8Array } | { ks256: Uint8Array },
  expiresAt?: number,
): Promise<Response> {
  const body =
    "ks256" in root
      ? { alg: -65799, key: bytesToBase64(root.ks256) }
      : { alg: "ES256", x: bytesToBase64(root.x), y: bytesToBase64(root.y) };
  return fetchWithDoRetry(`http://localhost/api/logs/${logUuid}/public-root`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...body,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    }),
  });
}

function getRoot(logUuid: string): Promise<Response> {
  return fetchWithDoRetry(`http://localhost/api/logs/${logUuid}/public-root`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      Accept: "application/cbor",
    },
  });
}

/** A root key pair plus a wide delegation certificate signed by it. */
async function rootWithCert(logHex32: string, seed: number) {
  const delegatedPublicKey = testDelegatedCoseKey(seed);
  const material = await buildTestByokMaterial({
    rootKeyPair: await generateTestRootKeyPair(),
    logIdHex32: logHex32,
    mmrStart: 0,
    mmrEnd: 16383,
    delegatedPublicKey,
    issuedAt: 1_700_000_000,
    expiresAt: FAR_FUTURE,
  });
  const submitCert = () =>
    fetchWithDoRetry("http://localhost/api/delegations/certificate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logId: logHex32,
        mmrStart: "0",
        mmrEnd: "16383",
        delegatedPublicKey: bytesToBase64(delegatedPublicKey),
        certificate: bytesToBase64(material.certificate),
        issuedAt: material.issuedAt,
        expiresAt: material.expiresAt,
      }),
    });
  return { root: { x: material.x, y: material.y }, submitCert };
}

/** Move a stored root's lapse time into the past, as the clock would. */
async function lapse(logHex32: string): Promise<void> {
  const stub = getStoreStubForLogId(env as unknown as Env, logHex32);
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE public_roots SET expires_at = 1
        WHERE log_id_hex32 = ? AND expires_at IS NOT NULL`,
      logHex32,
    );
  });
}

async function certCount(logHex32: string): Promise<number> {
  const stub = getStoreStubForLogId(env as unknown as Env, logHex32);
  return runInDurableObject(stub, async (_instance, state) => {
    const rows = [
      ...state.storage.sql.exec(
        `SELECT 1 FROM delegation_certificates WHERE log_id_hex32 = ?`,
        logHex32,
      ),
    ];
    return rows.length;
  });
}

describe("public root is stored once", () => {
  it("the same key again is 200; a different key is 409 and the stored root is unchanged", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const first = await rootWithCert(logHex32, 301);
    const squat = await rootWithCert(logHex32, 302);

    expect((await postRoot(logUuid, first.root)).status).toBe(200);
    expect((await postRoot(logUuid, first.root)).status).toBe(200);
    const refused = await postRoot(logUuid, squat.root);
    expect(refused.status).toBe(409);

    // The first owner's certificate still verifies; the squatter's does not.
    expect((await first.submitCert()).status).toBe(200);
    expect((await squat.submitCert()).status).not.toBe(200);
  });

  it("a KS256 root is compared by address", async () => {
    const logUuid = randomUUID();
    const a = new Uint8Array(20).fill(0xa1);
    const b = new Uint8Array(20).fill(0xb2);

    expect((await postRoot(logUuid, { ks256: a })).status).toBe(200);
    expect((await postRoot(logUuid, { ks256: a })).status).toBe(200);
    expect((await postRoot(logUuid, { ks256: b })).status).toBe(409);
  });

  it("a prepare root accepts certificates under it while it is reserved", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const owner = await rootWithCert(logHex32, 303);

    expect((await postRoot(logUuid, owner.root, FAR_FUTURE)).status).toBe(200);
    expect((await owner.submitCert()).status).toBe(200);
  });

  it("after expiresAt, a prepare root and the certificates under it are absent", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const lapsed = await rootWithCert(logHex32, 304);
    const next = await rootWithCert(logHex32, 305);

    expect((await postRoot(logUuid, lapsed.root, FAR_FUTURE)).status).toBe(200);
    expect((await lapsed.submitCert()).status).toBe(200);
    await lapse(logHex32);

    expect((await getRoot(logUuid)).status).toBe(404);
    expect(await certCount(logHex32)).toBe(0);
    // Another owner's claim may now register its root.
    expect((await postRoot(logUuid, next.root, FAR_FUTURE)).status).toBe(200);
    expect((await next.submitCert()).status).toBe(200);
  });

  it("the create forward makes a prepare root permanent", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const owner = await rootWithCert(logHex32, 306);

    expect((await postRoot(logUuid, owner.root, FAR_FUTURE)).status).toBe(200);
    expect((await postRoot(logUuid, owner.root)).status).toBe(200);
    await lapse(logHex32);

    expect((await getRoot(logUuid)).status).toBe(200);
  });

  it("a later prepare does not make a permanent root lapse", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const owner = await rootWithCert(logHex32, 307);

    expect((await postRoot(logUuid, owner.root)).status).toBe(200);
    expect((await postRoot(logUuid, owner.root, FAR_FUTURE)).status).toBe(200);
    await lapse(logHex32);

    expect((await getRoot(logUuid)).status).toBe(200);
  });

  it("refuses an expiresAt that is not a positive integer", async () => {
    const logUuid = randomUUID();
    const owner = await rootWithCert(normalizeLogIdToHex32(logUuid), 308);

    expect((await postRoot(logUuid, owner.root, -5)).status).toBe(400);
    expect((await postRoot(logUuid, owner.root, 1.5)).status).toBe(400);
  });
});
