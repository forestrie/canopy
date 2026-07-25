/**
 * Payment-registration graph ancestor walk (FOR-90).
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import { logIdToWireBytes } from "../src/grant/log-id-wire.js";
import {
  readRegistration,
  writeRegistration,
} from "../src/payments/registration-store.js";
import {
  liableAccountKey,
  resolvePaymentAncestor,
} from "../src/payments/resolve-payment-ancestor.js";

const poolEnv = env as unknown as Env;

const TEST_ADDR = new Uint8Array(20).fill(0xab);

describe("resolvePaymentAncestor", () => {
  it("accepts payment-authoritative root directly", async () => {
    const r = crypto.randomUUID();
    await writeRegistration(poolEnv, logIdToWireBytes(r), {
      class: "payment-authoritative",
      onboardTokenRef: "abc",
      chainBinding: { chainId: "84532", univocityAddr: "ab".repeat(20) },
      createdAt: 1,
    });
    const result = await resolvePaymentAncestor(poolEnv, r);
    expect(result).toEqual({
      ok: true,
      root: r,
      account: { root: r, chainId: "84532", univocityAddr: "ab".repeat(20) },
    });
  });

  it("walks endorsed-by chain to payment-authoritative root", async () => {
    const pa = crypto.randomUUID();
    const mid = crypto.randomUUID();
    const leaf = crypto.randomUUID();
    await writeRegistration(poolEnv, logIdToWireBytes(pa), {
      class: "payment-authoritative",
      onboardTokenRef: "hash",
      chainBinding: { chainId: "84532", univocityAddr: "ab".repeat(20) },
      createdAt: 1,
    });
    await writeRegistration(poolEnv, logIdToWireBytes(mid), {
      class: "regular",
      endorsedBy: pa,
      chainBinding: { chainId: "84532", univocityAddr: "ab".repeat(20) },
      createdAt: 2,
    });
    await writeRegistration(poolEnv, logIdToWireBytes(leaf), {
      class: "regular",
      endorsedBy: mid,
      chainBinding: { chainId: "84532", univocityAddr: "ab".repeat(20) },
      createdAt: 3,
    });

    const fromMid = await resolvePaymentAncestor(poolEnv, mid);
    expect(fromMid).toEqual({
      ok: true,
      root: pa,
      account: { root: pa, chainId: "84532", univocityAddr: "ab".repeat(20) },
    });

    const record = await readRegistration(poolEnv, logIdToWireBytes(leaf));
    expect(record?.endorsedBy).toBe(mid);
  });

  it("rejects missing registration", async () => {
    const result = await resolvePaymentAncestor(poolEnv, crypto.randomUUID());
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects cycle in endorsed-by graph", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await writeRegistration(poolEnv, logIdToWireBytes(a), {
      class: "regular",
      endorsedBy: b,
      chainBinding: { chainId: "84532", univocityAddr: "ab".repeat(20) },
      createdAt: 1,
    });
    await writeRegistration(poolEnv, logIdToWireBytes(b), {
      class: "regular",
      endorsedBy: a,
      chainBinding: { chainId: "84532", univocityAddr: "ab".repeat(20) },
      createdAt: 2,
    });
    const result = await resolvePaymentAncestor(poolEnv, a);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("cycle");
  });
});

describe("FOR-435: the liable account is resolved, never self-declared", () => {
  it("bills the payment-authoritative ancestor's chainBinding, not the leaf's", async () => {
    const pa = crypto.randomUUID();
    const leaf = crypto.randomUUID();
    await writeRegistration(poolEnv, logIdToWireBytes(pa), {
      class: "payment-authoritative",
      chainBinding: { chainId: "84532", univocityAddr: "ab".repeat(20) },
      createdAt: 1,
    });
    // The leaf names a DIFFERENT chain binding. It must not become the account:
    // that is how an owner would shed arrears by re-parenting.
    await writeRegistration(poolEnv, logIdToWireBytes(leaf), {
      class: "regular",
      endorsedBy: pa,
      chainBinding: { chainId: "1", univocityAddr: "cd".repeat(20) },
      createdAt: 2,
    });
    const res = await resolvePaymentAncestor(poolEnv, leaf);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.account.univocityAddr).toBe("ab".repeat(20));
    expect(res.account.chainId).toBe("84532");
    expect(res.account.root).toBe(pa);
  });

  it("does not bill a payment-authoritative root with no chain binding", async () => {
    const pa = crypto.randomUUID();
    await writeRegistration(poolEnv, logIdToWireBytes(pa), {
      class: "payment-authoritative",
      chainBinding: { chainId: "", univocityAddr: "" },
      createdAt: 1,
    });
    const res = await resolvePaymentAncestor(poolEnv, pa);
    expect(res).toEqual({ ok: false, reason: "missing" });
  });

  it("keys an account case-insensitively so one address is one account", () => {
    const mixed = liableAccountKey({
      root: "r",
      chainId: "84532",
      univocityAddr: "AB".repeat(20),
    });
    const lower = liableAccountKey({
      root: "r",
      chainId: "84532",
      univocityAddr: "ab".repeat(20),
    });
    expect(mixed).toBe(lower);
    expect(lower).toBe(`84532:${"ab".repeat(20)}`);
  });

  it("refuses to key an unpinned chainId format (FOR-471)", () => {
    // CAIP-2 form. Registration records store a BARE decimal chain id, so
    // accepting this would split one operator into two accounts.
    expect(() =>
      liableAccountKey({
        root: "r",
        chainId: "eip155:84532",
        univocityAddr: "ab".repeat(20),
      }),
    ).toThrow(/bare decimal id/);
  });

  it("refuses to key a malformed address", () => {
    expect(() =>
      liableAccountKey({
        root: "r",
        chainId: "84532",
        univocityAddr: "0xABCD",
      }),
    ).toThrow(/40 hex chars/);
  });
});
