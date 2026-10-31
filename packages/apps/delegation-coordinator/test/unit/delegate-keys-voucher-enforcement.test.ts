/**
 * Voucher expiry at registration, no-op upserts and expired rows
 * (plan-2609-12 slice 08 changes 1 to 3, ruling 7).
 *
 * The sealer asserts each key every minute with the voucher the custodian
 * issued (claim 4 = the voucher's notAfter), so the coordinator must refuse a
 * voucher without a usable claim 4, cap the row at it, and write nothing for
 * an assertion identical to the stored row.
 */

import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/certificate-key.js";
import {
  FAR_FUTURE,
  freshKey,
  listing,
  lookup,
  postRegistration,
  register,
  registrationBody,
  uniqueSealerId,
} from "./delegate-keys-client.js";

const DAY = 24 * 3600;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Problem {
  status: number;
  title: string;
  detail: string;
}

interface Record {
  notAfter: number;
  registeredAt: number;
}

async function recordOf(publicKey: Uint8Array): Promise<Record> {
  const res = await lookup(await sha256Hex(publicKey));
  expect(res.status).toBe(200);
  return (await res.json()) as Record;
}

describe("voucher claim 4 at registration", () => {
  it("refuses a voucher without claim 4 and writes nothing", async () => {
    const key = freshKey();
    const res = await register(uniqueSealerId("sealer-s08"), [
      { ...key, epoch: 1, voucherNotAfter: null },
    ]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Problem;
    // The sealer refreshes its vouchers on this title (arbor
    // delegate_key_registrar.go voucherFixes).
    expect(body.title).toBe("Invalid voucher");
    expect(body.detail).toContain("not_after_missing");
    expect((await lookup(await sha256Hex(key.publicKey))).status).toBe(404);
  });

  it("refuses a voucher whose claim 4 has passed", async () => {
    const res = await register(uniqueSealerId("sealer-s08"), [
      { ...freshKey(), epoch: 1, voucherNotAfter: nowSeconds() - 60 },
    ]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Problem;
    expect(body.title).toBe("Invalid voucher");
    expect(body.detail).toContain("expired");
  });

  it("refuses a voucher more than 31 days out", async () => {
    const res = await register(uniqueSealerId("sealer-s08"), [
      { ...freshKey(), epoch: 1, voucherNotAfter: nowSeconds() + 32 * DAY },
    ]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Problem;
    expect(body.title).toBe("Invalid voucher");
    expect(body.detail).toContain("not_after_too_far");
  });

  it("accepts a voucher 30 days out", async () => {
    const res = await register(uniqueSealerId("sealer-s08"), [
      { ...freshKey(), epoch: 1, voucherNotAfter: nowSeconds() + 30 * DAY },
    ]);
    expect(res.status).toBe(200);
  });

  it("stores claim 4 when the body notAfter is later", async () => {
    const key = freshKey();
    const claim4 = nowSeconds() + DAY;
    expect(
      (
        await register(uniqueSealerId("sealer-s08"), [
          { ...key, epoch: 1, notAfter: FAR_FUTURE, voucherNotAfter: claim4 },
        ])
      ).status,
    ).toBe(200);
    expect((await recordOf(key.publicKey)).notAfter).toBe(claim4);
  });

  it("stores the body notAfter when it is earlier than claim 4", async () => {
    const key = freshKey();
    const body = nowSeconds() + 3600;
    expect(
      (
        await register(uniqueSealerId("sealer-s08"), [
          { ...key, epoch: 1, notAfter: body, voucherNotAfter: body + DAY },
        ])
      ).status,
    ).toBe(200);
    expect((await recordOf(key.publicKey)).notAfter).toBe(body);
  });
});

describe("no-op upsert", () => {
  it("writes nothing for an identical registration", async () => {
    const sealerId = uniqueSealerId("sealer-s08");
    const key = freshKey();
    const claim4 = nowSeconds() + DAY;
    const body = await registrationBody(sealerId, [
      { ...key, epoch: 1, voucherNotAfter: claim4 },
    ]);
    const res = await postRegistration(body);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { written: number }).written).toBe(1);
    const first = await recordOf(key.publicKey);
    // registered_at has one-second resolution; cross a second boundary.
    await sleep(1100);
    const again = await postRegistration(body);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { written: number }).written).toBe(0);
    const second = await recordOf(key.publicKey);
    expect(second).toEqual(first);
  });

  it("rewrites the row and registeredAt for a refreshed voucher", async () => {
    const sealerId = uniqueSealerId("sealer-s08");
    const key = freshKey();
    const claim4 = nowSeconds() + DAY;
    expect(
      (
        await register(sealerId, [
          { ...key, epoch: 1, voucherNotAfter: claim4 },
        ])
      ).status,
    ).toBe(200);
    const first = await recordOf(key.publicKey);
    await sleep(1100);
    expect(
      (
        await register(sealerId, [
          { ...key, epoch: 1, voucherNotAfter: claim4 + 3600 },
        ])
      ).status,
    ).toBe(200);
    const second = await recordOf(key.publicKey);
    expect(second.notAfter).toBe(claim4 + 3600);
    expect(second.registeredAt).toBeGreaterThan(first.registeredAt);
  });
});

describe("expired rows are not registered", () => {
  it("lookup is 404 for an expired row the listing still marks", async () => {
    const sealerId = uniqueSealerId("sealer-s08");
    const key = freshKey();
    const hash = await sha256Hex(key.publicKey);
    const soon = nowSeconds() + 2;
    expect(
      (await register(sealerId, [{ ...key, epoch: 1, notAfter: soon }])).status,
    ).toBe(200);
    expect((await lookup(hash)).status).toBe(200);
    await sleep(2500);

    expect((await lookup(hash)).status).toBe(404);
    const res = await listing(sealerId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      keys: Array<{ pubkeyHash: string; expired: boolean }>;
    };
    expect(body.keys).toEqual([
      expect.objectContaining({ pubkeyHash: hash, expired: true }),
    ]);
  }, 15_000);

  it("the listing marks unexpired rows as not expired", async () => {
    const sealerId = uniqueSealerId("sealer-s08");
    expect(
      (await register(sealerId, [{ ...freshKey(), epoch: 1 }])).status,
    ).toBe(200);
    const body = (await (await listing(sealerId)).json()) as {
      keys: Array<{ expired: boolean }>;
    };
    expect(body.keys.map((k) => k.expired)).toEqual([false]);
  });
});
