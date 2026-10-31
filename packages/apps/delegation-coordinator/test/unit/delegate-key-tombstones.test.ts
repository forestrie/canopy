/**
 * Delegate-key tombstones (plan-2609-12 slice 08 change 4, ruling 8): the
 * operator-plane retirement of a key by hash, or of a sealer's epochs up to
 * a bound, on every shard. A tombstoned key's registration is refused with
 * 410, which the sealer treats as final.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/certificate-key.js";
import { normalizeLogIdToHex32 } from "../../src/log-id.js";
import {
  appTokenHeaders,
  freshKey,
  listing,
  lookup,
  register,
  TOMBSTONES,
  uniqueSealerId,
} from "./delegate-keys-client.js";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";
import {
  mintTestSessionToken,
  sessionHeaders,
} from "./wallet-session-helpers.js";

type TombstoneTarget =
  | { pubkeyHash: string }
  | { sealerId: string; maxEpoch: number };

async function tombstone(
  target: TombstoneTarget | Record<string, unknown>,
  reason = "test retirement",
  headers: HeadersInit = appTokenHeaders({
    "Content-Type": "application/json",
  }),
): Promise<Response> {
  return fetchWithDoRetry(TOMBSTONES, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...target, reason }),
  });
}

async function lift(target: TombstoneTarget): Promise<Response> {
  const q = new URLSearchParams(
    "pubkeyHash" in target
      ? { pubkeyHash: target.pubkeyHash }
      : { sealerId: target.sealerId, maxEpoch: String(target.maxEpoch) },
  );
  return fetchWithDoRetry(`${TOMBSTONES}?${q}`, {
    method: "DELETE",
    headers: appTokenHeaders(),
  });
}

interface ListedTombstone {
  pubkeyHash: string | null;
  sealerId: string | null;
  maxEpoch: number | null;
  reason: string;
  createdAt: number;
  shardsRecorded: number;
}

async function listed(sealerId: string): Promise<{
  keys: Array<{ pubkeyHash: string; epoch: number }>;
  tombstones: ListedTombstone[];
}> {
  const res = await listing(sealerId);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    keys: Array<{ pubkeyHash: string; epoch: number }>;
    tombstones: ListedTombstone[];
  };
}

describe("tombstone route gate and validation", () => {
  it("rejects a wallet session (operator plane only)", async () => {
    const token = mintTestSessionToken({
      authLogIdHex32: normalizeLogIdToHex32(randomUUID()),
      scopes: ["delegations:read"],
    });
    const res = await tombstone(
      { pubkeyHash: "a".repeat(64) },
      "x",
      sessionHeaders(token, { "Content-Type": "application/json" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a missing token", async () => {
    const res = await tombstone({ pubkeyHash: "a".repeat(64) }, "x", {
      "Content-Type": "application/json",
    });
    expect(res.status).toBe(401);
  });

  it.each([
    ["neither target", {}],
    [
      "both targets",
      { pubkeyHash: "a".repeat(64), sealerId: "s", maxEpoch: 1 },
    ],
    ["a malformed hash", { pubkeyHash: "not-a-hash" }],
    ["sealerId without maxEpoch", { sealerId: "s" }],
    ["maxEpoch below 1", { sealerId: "s", maxEpoch: 0 }],
    ["a fractional maxEpoch", { sealerId: "s", maxEpoch: 1.5 }],
  ])("refuses %s with 400", async (_name, target) => {
    expect((await tombstone(target)).status).toBe(400);
  });

  it("requires a reason", async () => {
    const omitted = await fetchWithDoRetry(TOMBSTONES, {
      method: "POST",
      headers: appTokenHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ pubkeyHash: "a".repeat(64) }),
    });
    expect(omitted.status).toBe(400);
    expect((await tombstone({ pubkeyHash: "a".repeat(64) }, "  ")).status).toBe(
      400,
    );
  });
});

describe("hash tombstone", () => {
  it("deletes the row, refuses re-registration with 410, and is listed", async () => {
    const sealerId = uniqueSealerId("sealer-s08");
    const key = freshKey();
    const hash = await sha256Hex(key.publicKey);
    expect((await register(sealerId, [{ ...key, epoch: 1 }])).status).toBe(200);

    const res = await tombstone({ pubkeyHash: hash }, "seed leaked");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1, shards: 4 });
    expect((await lookup(hash)).status).toBe(404);

    const again = await register(sealerId, [{ ...key, epoch: 1 }]);
    expect(again.status).toBe(410);
    const problem = (await again.json()) as {
      title: string;
      detail: string;
      pubkeyHash: string;
      epoch: number;
      reason: string;
    };
    expect(problem.title).toBe("Gone");
    expect(problem.detail).toContain("seed leaked");
    expect(problem.pubkeyHash).toBe(hash);
    expect(problem.epoch).toBe(1);
    expect(problem.reason).toBe("seed leaked");
    expect((await lookup(hash)).status).toBe(404);

    const body = await listed(sealerId);
    expect(body.keys).toEqual([]);
    expect(body.tombstones).toEqual([
      {
        pubkeyHash: hash,
        sealerId,
        maxEpoch: null,
        reason: "seed leaked",
        createdAt: expect.any(Number),
        shardsRecorded: 4,
      },
    ]);
  });

  it("is checked before one key per (sealer, epoch)", async () => {
    const sealerId = uniqueSealerId("sealer-s08");
    const standing = freshKey();
    const retired = freshKey();
    expect((await register(sealerId, [{ ...standing, epoch: 1 }])).status).toBe(
      200,
    );
    // Never registered: the tombstone deletes nothing but still refuses it.
    const res = await tombstone({
      pubkeyHash: await sha256Hex(retired.publicKey),
    });
    expect(((await res.json()) as { deleted: number }).deleted).toBe(0);
    expect((await register(sealerId, [{ ...retired, epoch: 1 }])).status).toBe(
      410,
    );
  });

  it("is idempotent and lifting it lets registration succeed", async () => {
    const sealerId = uniqueSealerId("sealer-s08");
    const key = freshKey();
    const hash = await sha256Hex(key.publicKey);
    expect((await tombstone({ pubkeyHash: hash }, "mistake")).status).toBe(200);
    expect((await tombstone({ pubkeyHash: hash }, "mistake")).status).toBe(200);
    expect((await register(sealerId, [{ ...key, epoch: 1 }])).status).toBe(410);

    const res = await lift({ pubkeyHash: hash });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lifted: 1, shards: 4 });
    expect((await register(sealerId, [{ ...key, epoch: 1 }])).status).toBe(200);
    expect((await lift({ pubkeyHash: hash })).status).toBe(200);
  });
});

describe("(sealer, max epoch) tombstone", () => {
  it("retires epochs up to the bound and leaves later epochs registrable", async () => {
    const sealerId = uniqueSealerId("sealer-s08");
    const otherSealer = uniqueSealerId("sealer-s08");
    const e1 = freshKey();
    const e2 = freshKey();
    const e3 = freshKey();
    const other = freshKey();
    expect(
      (
        await register(sealerId, [
          { ...e1, epoch: 1 },
          { ...e2, epoch: 2 },
          { ...e3, epoch: 3 },
        ])
      ).status,
    ).toBe(200);
    expect((await register(otherSealer, [{ ...other, epoch: 1 }])).status).toBe(
      200,
    );

    const res = await tombstone(
      { sealerId, maxEpoch: 2 },
      "versions 1-2 disabled",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2, shards: 4 });

    expect((await lookup(await sha256Hex(e1.publicKey))).status).toBe(404);
    expect((await lookup(await sha256Hex(e2.publicKey))).status).toBe(404);
    expect((await lookup(await sha256Hex(e3.publicKey))).status).toBe(200);
    expect((await lookup(await sha256Hex(other.publicKey))).status).toBe(200);

    expect((await register(sealerId, [{ ...e2, epoch: 2 }])).status).toBe(410);
    // A fresh key for a tombstoned epoch is refused too.
    expect(
      (await register(sealerId, [{ ...freshKey(), epoch: 1 }])).status,
    ).toBe(410);
    expect((await register(sealerId, [{ ...e3, epoch: 3 }])).status).toBe(200);
    expect(
      (await register(sealerId, [{ ...freshKey(), epoch: 4 }])).status,
    ).toBe(200);
    expect((await register(otherSealer, [{ ...other, epoch: 1 }])).status).toBe(
      200,
    );

    const body = await listed(sealerId);
    expect(body.keys.map((k) => k.epoch)).toEqual([4, 3]);
    expect(body.tombstones).toEqual([
      expect.objectContaining({
        pubkeyHash: null,
        sealerId,
        maxEpoch: 2,
        reason: "versions 1-2 disabled",
        shardsRecorded: 4,
      }),
    ]);

    expect((await lift({ sealerId, maxEpoch: 2 })).status).toBe(200);
    expect((await register(sealerId, [{ ...e2, epoch: 2 }])).status).toBe(200);
  });
});
