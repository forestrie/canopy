import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { Env } from "../src/env.js";

const typedEnv = env as Env;

const ACCOUNT = {
  univocityInstanceId:
    "eip155:84532:0xabababababababababababababababababababab",
  chainId: "84532",
  univocityAddr: "abababababababababababababababababababab",
  root: "11111111-1111-4111-8111-111111111111",
};

/** A fresh DO instance per test, so state cannot leak between cases. */
let n = 0;
function freshStub() {
  n += 1;
  const key = `${ACCOUNT.univocityInstanceId}#${n}`;
  const account = { ...ACCOUNT, univocityInstanceId: key };
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
      univocityInstanceId:
        "eip155:1:0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
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
    await expect(stub.getEntitlement("eip155:84532:0xffff")).rejects.toThrow(
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

describe("ReceivablesDO — prepaid credits and batch apply (ADR-0059 D3, slice 03)", () => {
  it("decrements the prepaid balance per accrued checkpoint", async () => {
    const { stub, account, key } = freshStub();
    await stub.accrueCheckpoints(account, "evt-1", 2);
    const e = await stub.getEntitlement(key);
    expect(e?.creditsBalance).toBe(-2);
    expect(e?.creditFloor).toBe(0);
  });

  it("applies a batch idempotently and advances the watermark", async () => {
    const { stub, account, key } = freshStub();
    const events = [
      { idempotencyKey: "0xtx1:0", logKind: 1, size: 4 },
      { idempotencyKey: "0xtx1:1", logKind: 2, size: 9 },
    ];
    const first = await stub.applyCheckpointEvents(account, events, 1000);
    expect(first.checkpointsAccrued).toBe(2);
    expect(first.creditsBalance).toBe(-2);

    // A rescan of the same range replays the same events: no double count,
    // and the watermark never rewinds.
    const replay = await stub.applyCheckpointEvents(account, events, 900);
    expect(replay.checkpointsAccrued).toBe(2);
    const state = await stub.getIndexState(key);
    expect(state.lastBlock).toBe(1000);
  });

  it("advances the watermark on an empty range — empty scans still progress", async () => {
    const { stub, account, key } = freshStub();
    await stub.applyCheckpointEvents(account, [], 555);
    const state = await stub.getIndexState(key);
    expect(state.lastBlock).toBe(555);
    // No events → no account activity beyond the row itself.
    expect(state.entitlement?.checkpointsAccrued).toBe(0);
  });

  it("derives arrears from balance vs floor on batch apply", async () => {
    const { stub, account, key } = freshStub();
    const e = await stub.applyCheckpointEvents(
      account,
      [{ idempotencyKey: "0xtx2:0", logKind: 2, size: 1 }],
      10,
    );
    // Zero credits, one accrual: below the default floor of 0.
    expect(e.creditsBalance).toBe(-1);
    expect(e.arrears).toBe("in-arrears");
    expect((await stub.getEntitlement(key))?.arrears).toBe("in-arrears");
  });

  it("rejects an event with an empty idempotency key", async () => {
    const { stub, account } = freshStub();
    await expect(
      stub.applyCheckpointEvents(
        account,
        [{ idempotencyKey: " ", logKind: 1, size: 1 }],
        10,
      ),
    ).rejects.toThrow(/idempotencyKey/);
  });

  it("getIndexState returns nulls for an untouched account", async () => {
    const { stub, key } = freshStub();
    const state = await stub.getIndexState(key);
    expect(state.entitlement).toBeNull();
    expect(state.lastBlock).toBeNull();
  });
});
