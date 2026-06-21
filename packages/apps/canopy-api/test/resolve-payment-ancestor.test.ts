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
import { resolvePaymentAncestor } from "../src/payments/resolve-payment-ancestor.js";

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
    expect(result).toEqual({ ok: true, root: r });
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
    expect(fromMid).toEqual({ ok: true, root: pa });

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
