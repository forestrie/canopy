/**
 * Delegate-key read routes, the one-key-per-(sealer, epoch) invariant and the
 * operator-plane delete (plan-2609-12 slice 04, rulings 1 and 4).
 *
 * Runs against the real worker + sharded DO (vitest-pool-workers) whose store
 * is shared across suites. Sealer ids are unique per test and key material is
 * random, so nothing here collides with another suite: pubkey_hash is a
 * global primary key.
 */

import { randomUUID } from "node:crypto";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { shardNameForIndex } from "@canopy/forestrie-sharding";
import { bytesToBase64 } from "../../src/encoding.js";
import { sha256Hex } from "../../src/certificate-key.js";
import { normalizeLogIdToHex32 } from "../../src/log-id.js";
import {
  buildTestByokMaterial,
  generateTestRootKeyPair,
} from "./byok-material-fixture.js";
import {
  ADMIN_BASE,
  appTokenHeaders,
  BASE,
  FAR_FUTURE,
  freshKey,
  listing,
  lookup,
  register,
  uniqueSealerId,
} from "./delegate-keys-client.js";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";
import {
  mintTestSessionToken,
  sessionHeaders,
} from "./wallet-session-helpers.js";

async function adminDelete(sealerId: string): Promise<Response> {
  return fetchWithDoRetry(
    `${ADMIN_BASE}?sealerId=${encodeURIComponent(sealerId)}`,
    { method: "DELETE", headers: appTokenHeaders() },
  );
}

/**
 * Register a root and submit one advance certificate bound to the key.
 *
 * @returns The log's hex32 id, which selects the shard holding the row.
 */
async function seedCertificate(
  delegatedPublicKey: Uint8Array,
): Promise<string> {
  const logUuid = randomUUID();
  const logHex32 = normalizeLogIdToHex32(logUuid);
  const rootKeyPair = await generateTestRootKeyPair();
  const material = await buildTestByokMaterial({
    rootKeyPair,
    logIdHex32: logHex32,
    mmrStart: 0,
    mmrEnd: 1000,
    delegatedPublicKey,
    issuedAt: 1_700_000_000,
    expiresAt: FAR_FUTURE,
  });
  const rootRes = await fetchWithDoRetry(
    `http://localhost/api/logs/${logUuid}/public-root`,
    {
      method: "POST",
      headers: appTokenHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        alg: "ES256",
        x: bytesToBase64(material.x),
        y: bytesToBase64(material.y),
      }),
    },
  );
  expect(rootRes.status).toBe(200);
  const certRes = await fetchWithDoRetry(
    "http://localhost/api/delegations/certificate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logId: logHex32,
        mmrStart: "0",
        mmrEnd: "1000",
        delegatedPublicKey: bytesToBase64(delegatedPublicKey),
        certificate: bytesToBase64(material.certificate),
        issuedAt: material.issuedAt,
        expiresAt: material.expiresAt,
      }),
    },
  );
  expect(certRes.status).toBe(200);
  return logHex32;
}

/**
 * Backdate a log's certificate expiry inside the store. Submission refuses a
 * stale certificate, so an expired row can only be produced this way. Runs on
 * every shard; only the log's shard holds the row.
 */
async function expireCertificates(logHex32: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const stub = env.DELEGATION_STORE.get(
      env.DELEGATION_STORE.idFromName(shardNameForIndex(i)),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE delegation_certificates SET expires_at = 1700000001
          WHERE log_id_hex32 = ?`,
        logHex32,
      );
    });
  }
}

describe("GET /api/sealer/delegate-keys/{pubkeyHash}", () => {
  it("requires the app token", async () => {
    const res = await fetchWithDoRetry(`${BASE}/${"0".repeat(64)}`);
    expect(res.status).toBe(401);
  });

  it("rejects a malformed hash", async () => {
    const res = await lookup("not-a-hash");
    expect(res.status).toBe(400);
  });

  it("is 404 for a hash that was never registered", async () => {
    const res = await lookup("f".repeat(64));
    expect(res.status).toBe(404);
  });

  it("returns the registered binding with registeredAt", async () => {
    const sealerId = uniqueSealerId();
    const key = freshKey();
    const before = Math.floor(Date.now() / 1000);
    expect((await register(sealerId, [{ ...key, epoch: 1 }])).status).toBe(200);
    const hash = await sha256Hex(key.publicKey);
    const res = await lookup(hash);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pubkeyHash: string;
      sealerId: string;
      epoch: number;
      notAfter: number;
      registeredAt: number | null;
      shards: number;
    };
    expect(body.pubkeyHash).toBe(hash);
    expect(body.sealerId).toBe(sealerId);
    expect(body.epoch).toBe(1);
    // The body asks for 2100; the row is capped at the voucher's claim 4.
    expect(body.notAfter).toBeGreaterThan(before);
    expect(body.notAfter).toBeLessThan(FAR_FUTURE);
    expect(body.registeredAt).toBeGreaterThanOrEqual(before);
    expect(body.shards).toBe(4);
  });
});

describe("one key per (sealerId, epoch)", () => {
  it("refuses a different key for a registered epoch with both hashes", async () => {
    const sealerId = uniqueSealerId();
    const good = freshKey();
    const wrong = freshKey();
    expect((await register(sealerId, [{ ...good, epoch: 3 }])).status).toBe(
      200,
    );
    const res = await register(sealerId, [{ ...wrong, epoch: 3 }]);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      status: number;
      detail: string;
      sealerId: string;
      epoch: number;
      pubkeyHash: string;
      existingPubkeyHash: string;
    };
    const goodHash = await sha256Hex(good.publicKey);
    const wrongHash = await sha256Hex(wrong.publicKey);
    expect(body.sealerId).toBe(sealerId);
    expect(body.epoch).toBe(3);
    expect(body.pubkeyHash).toBe(wrongHash);
    expect(body.existingPubkeyHash).toBe(goodHash);
    expect(body.detail).toContain(goodHash);
    expect(body.detail).toContain(wrongHash);
    // The registered key stands; the refused one was never written.
    expect((await lookup(goodHash)).status).toBe(200);
    expect((await lookup(wrongHash)).status).toBe(404);
  });

  it("refuses a batch carrying two keys for one epoch and writes none of it", async () => {
    const sealerId = uniqueSealerId();
    const a = freshKey();
    const b = freshKey();
    const res = await register(sealerId, [
      { ...a, epoch: 1 },
      { ...b, epoch: 1 },
    ]);
    expect(res.status).toBe(409);
    expect((await lookup(await sha256Hex(a.publicKey))).status).toBe(404);
    expect((await lookup(await sha256Hex(b.publicKey))).status).toBe(404);
  });

  it("allows a different key for a different epoch of the same sealer", async () => {
    const sealerId = uniqueSealerId();
    const e1 = freshKey();
    const e2 = freshKey();
    expect((await register(sealerId, [{ ...e1, epoch: 1 }])).status).toBe(200);
    expect((await register(sealerId, [{ ...e2, epoch: 2 }])).status).toBe(200);
  });

  it("does not scope the invariant across sealers", async () => {
    const a = freshKey();
    const b = freshKey();
    expect(
      (await register(uniqueSealerId(), [{ ...a, epoch: 1 }])).status,
    ).toBe(200);
    expect(
      (await register(uniqueSealerId(), [{ ...b, epoch: 1 }])).status,
    ).toBe(200);
  });

  it("lets an expired predecessor be replaced", async () => {
    const sealerId = uniqueSealerId();
    const old = freshKey();
    const next = freshKey();
    const soon = Math.floor(Date.now() / 1000) + 2;
    expect(
      (await register(sealerId, [{ ...old, epoch: 1, notAfter: soon }])).status,
    ).toBe(200);
    await new Promise((r) => setTimeout(r, 2500));
    const res = await register(sealerId, [{ ...next, epoch: 1 }]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { retired: number }).retired).toBe(4);
    expect((await lookup(await sha256Hex(old.publicKey))).status).toBe(404);
    expect((await lookup(await sha256Hex(next.publicKey))).status).toBe(200);
  }, 15_000);
});

describe("GET /api/sealer/delegate-keys?sealerId=", () => {
  it("requires the app token", async () => {
    const res = await fetchWithDoRetry(`${BASE}?sealerId=x`);
    expect(res.status).toBe(401);
  });

  it("requires sealerId", async () => {
    const res = await fetchWithDoRetry(BASE, { headers: appTokenHeaders() });
    expect(res.status).toBe(400);
  });

  it("lists the sealer's keys, epoch descending, with unexpired certificate counts", async () => {
    const sealerId = uniqueSealerId();
    const e1 = freshKey();
    const e2 = freshKey();

    // Certificates first: once a key is registered, an advance certificate
    // bound to it must carry an on-chain signature, which is out of scope
    // here. Three logs (spread over shards) hold unexpired certs bound to the
    // epoch-1 key; one more holds an expired cert, which must not count.
    for (let i = 0; i < 3; i++) {
      await seedCertificate(e1.publicKey);
    }
    await expireCertificates(await seedCertificate(e1.publicKey));

    expect(
      (
        await register(sealerId, [
          { ...e1, epoch: 1 },
          { ...e2, epoch: 2 },
        ])
      ).status,
    ).toBe(200);
    const e1Hash = await sha256Hex(e1.publicKey);
    const e2Hash = await sha256Hex(e2.publicKey);

    const res = await listing(sealerId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sealerId: string;
      shards: number;
      keys: Array<{
        pubkeyHash: string;
        epoch: number;
        notAfter: number;
        registeredAt: number | null;
        unexpiredCertificates: number;
        shardsRegistered: number;
      }>;
    };
    expect(body.sealerId).toBe(sealerId);
    expect(body.shards).toBe(4);
    expect(body.keys.map((k) => k.epoch)).toEqual([2, 1]);
    const [k2, k1] = body.keys;
    expect(k2!.pubkeyHash).toBe(e2Hash);
    expect(k2!.unexpiredCertificates).toBe(0);
    expect(k2!.shardsRegistered).toBe(4);
    expect(k1!.pubkeyHash).toBe(e1Hash);
    expect(k1!.unexpiredCertificates).toBe(3);
    expect(k1!.shardsRegistered).toBe(4);
    expect(k1!.registeredAt).not.toBeNull();
  });

  it("is empty for an unknown sealer", async () => {
    const res = await listing(uniqueSealerId());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { keys: unknown[] }).keys).toEqual([]);
  });
});

describe("DELETE /admin/api/sealer/delegate-keys?sealerId=", () => {
  it("rejects a wallet session (operator plane only)", async () => {
    const token = mintTestSessionToken({
      authLogIdHex32: normalizeLogIdToHex32(randomUUID()),
      scopes: ["delegations:read"],
    });
    const res = await fetchWithDoRetry(`${ADMIN_BASE}?sealerId=x`, {
      method: "DELETE",
      headers: sessionHeaders(token),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a missing token", async () => {
    const res = await fetchWithDoRetry(`${ADMIN_BASE}?sealerId=x`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("is not exposed on the sealer plane", async () => {
    const res = await fetchWithDoRetry(`${BASE}?sealerId=x`, {
      method: "DELETE",
      headers: appTokenHeaders(),
    });
    expect(res.status).toBe(405);
  });

  it("requires sealerId (never an unscoped wipe)", async () => {
    const res = await fetchWithDoRetry(ADMIN_BASE, {
      method: "DELETE",
      headers: appTokenHeaders(),
    });
    expect(res.status).toBe(400);
  });

  it("removes only that sealer's keys and unblocks a replacement key", async () => {
    const sealerId = uniqueSealerId();
    const otherSealer = uniqueSealerId();
    const old = freshKey();
    const other = freshKey();
    const replacement = freshKey();
    expect((await register(sealerId, [{ ...old, epoch: 1 }])).status).toBe(200);
    expect((await register(otherSealer, [{ ...other, epoch: 1 }])).status).toBe(
      200,
    );
    // Pre-flight: a replacement is refused while the old key stands.
    expect(
      (await register(sealerId, [{ ...replacement, epoch: 1 }])).status,
    ).toBe(409);

    const del = await adminDelete(sealerId);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ sealerId, deleted: 1, shards: 4 });

    expect((await lookup(await sha256Hex(old.publicKey))).status).toBe(404);
    expect((await lookup(await sha256Hex(other.publicKey))).status).toBe(200);
    expect(
      (await register(sealerId, [{ ...replacement, epoch: 1 }])).status,
    ).toBe(200);

    const again = await adminDelete(uniqueSealerId());
    expect(((await again.json()) as { deleted: number }).deleted).toBe(0);
  });
});
