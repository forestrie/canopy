import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { Env } from "../src/env.js";

const typedEnv = env as Env;

const ACCOUNT = {
  accountKey: "84532:abababababababababababababababababababab",
  chainId: "84532",
  univocityAddr: "abababababababababababababababababababab",
  root: "11111111-1111-4111-8111-111111111111",
};

/** A fresh DO instance per test, so state cannot leak between cases. */
let n = 0;
function freshStub() {
  n += 1;
  const key = `${ACCOUNT.accountKey}#${n}`;
  const account = { ...ACCOUNT, accountKey: key };
  const id = typedEnv.RECEIVABLES_DO.idFromName(key);
  return { stub: typedEnv.RECEIVABLES_DO.get(id), account, key };
}

describe("ReceivablesDO — entitlement reads", () => {
  it("returns null for an account with no activity", async () => {
    const { stub, key } = freshStub();
    // ADR-0058: callers MUST read null as "nothing owed", never as
    // "unknown, therefore refuse" — otherwise every new customer's first
    // 402 fails.
    expect(await stub.getEntitlement(key)).toBeNull();
  });

  it("reports accrued checkpoints and a starting arrears posture", async () => {
    const { stub, account, key } = freshStub();
    await stub.accrueCheckpoints(account, "evt-1", 3);
    const e = await stub.getEntitlement(key);
    expect(e?.checkpointsAccrued).toBe(3);
    expect(e?.arrears).toBe("current");
    expect(e?.root).toBe(account.root);
  });
});

describe("ReceivablesDO — accrual is idempotent (FOR-470)", () => {
  it("does not double-count a replayed idempotency key", async () => {
    const { stub, account, key } = freshStub();
    await stub.accrueCheckpoints(account, "evt-dup", 2);
    await stub.accrueCheckpoints(account, "evt-dup", 2);
    await stub.accrueCheckpoints(account, "evt-dup", 2);
    // Queue delivery is at-least-once, and nothing downstream reconciles
    // (ADR-0058 §7), so the dedup has to hold here.
    expect((await stub.getEntitlement(key))?.checkpointsAccrued).toBe(2);
  });

  it("accrues distinct events independently", async () => {
    const { stub, account, key } = freshStub();
    await stub.accrueCheckpoints(account, "evt-a", 1);
    await stub.accrueCheckpoints(account, "evt-b", 4);
    expect((await stub.getEntitlement(key))?.checkpointsAccrued).toBe(5);
  });

  it("rejects an empty idempotency key rather than accruing blind", async () => {
    const { stub, account } = freshStub();
    await expect(stub.accrueCheckpoints(account, "  ", 1)).rejects.toThrow(
      /idempotencyKey/,
    );
  });

  it("rejects a non-positive count", async () => {
    const { stub, account } = freshStub();
    await expect(stub.accrueCheckpoints(account, "evt-x", 0)).rejects.toThrow(
      /positive integer count/,
    );
  });
});

describe("ReceivablesDO — instance identity is bound (FOR-472)", () => {
  it("refuses an operation for a different account", async () => {
    const { stub, account } = freshStub();
    await stub.accrueCheckpoints(account, "evt-1", 1);
    const other = {
      ...account,
      accountKey: "1:cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    };
    // Routing the wrong account here would otherwise land a second row and
    // read back cleanly — silent cross-account contamination.
    await expect(stub.accrueCheckpoints(other, "evt-2", 1)).rejects.toThrow(
      /bound to account/,
    );
  });

  it("refuses a read for a different account", async () => {
    const { stub, account } = freshStub();
    await stub.accrueCheckpoints(account, "evt-1", 1);
    await expect(stub.getEntitlement("84532:ffff")).rejects.toThrow(
      /bound to account/,
    );
  });
});

describe("ReceivablesDO — subtree counters (§4)", () => {
  it("counts registrations and tracks the deepest observed depth", async () => {
    const { stub, account, key } = freshStub();
    await stub.noteRegistration(account, 1);
    await stub.noteRegistration(account, 3);
    await stub.noteRegistration(account, 2);
    const e = await stub.getEntitlement(key);
    expect(e?.subtreeRegistrations).toBe(3);
    // MAX, not last-write-wins.
    expect(e?.subtreeMaxDepth).toBe(3);
  });

  it("rejects a non-positive depth", async () => {
    const { stub, account } = freshStub();
    await expect(stub.noteRegistration(account, 0)).rejects.toThrow(
      /positive integer depth/,
    );
  });
});

describe("ReceivablesDO — arrears posture (§7)", () => {
  it("moves through the allowed states", async () => {
    const { stub, account, key } = freshStub();
    await stub.accrueCheckpoints(account, "evt-1", 1);
    expect((await stub.setArrears(key, "in-arrears"))?.arrears).toBe(
      "in-arrears",
    );
    expect((await stub.setArrears(key, "current"))?.arrears).toBe("current");
    expect((await stub.getEntitlement(key))?.arrears).toBe("current");
  });

  it("rejects an unknown state instead of storing it", async () => {
    const { stub, account, key } = freshStub();
    await stub.accrueCheckpoints(account, "evt-1", 1);
    await expect(stub.setArrears(key, "delinquent" as never)).rejects.toThrow(
      /unknown arrears state/,
    );
  });

  it("returns null for an account that does not exist yet", async () => {
    const { stub, key } = freshStub();
    expect(await stub.setArrears(key, "in-arrears")).toBeNull();
  });

  it("does not alter the accrued count", async () => {
    const { stub, account, key } = freshStub();
    await stub.accrueCheckpoints(account, "evt-1", 7);
    await stub.setArrears(key, "in-arrears");
    // Billing and deactivation stay separate (§7): a posture change is a
    // judgement, not a balance mutation.
    expect((await stub.getEntitlement(key))?.checkpointsAccrued).toBe(7);
  });
});
