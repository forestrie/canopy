/**
 * Receiver ownership check (ADR-0005 amendment, FOR-468).
 *
 * An instance-level webhook asks one endpoint about many logs, so a valid
 * coordinator signature is not authority to sign for whichever log the event
 * names. The receiver decides that separately.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildOwnedLogIndex,
  resolveOwnedLogId,
} from "../src/mode-c-webhook-receiver.js";

describe("resolveOwnedLogId", () => {
  it("resolves an owned log, dashed or undashed", () => {
    const owned = randomUUID();
    const index = buildOwnedLogIndex([owned]);
    expect(resolveOwnedLogId(index, owned)).toBe(owned);
    expect(resolveOwnedLogId(index, owned.replace(/-/g, ""))).toBe(owned);
  });

  it("refuses a log the receiver does not own", () => {
    const index = buildOwnedLogIndex([randomUUID(), randomUUID()]);
    expect(resolveOwnedLogId(index, randomUUID())).toBeUndefined();
  });

  it("serves several owned logs from one endpoint", () => {
    const owned = [randomUUID(), randomUUID(), randomUUID()];
    const index = buildOwnedLogIndex(owned);
    for (const uuid of owned) {
      expect(resolveOwnedLogId(index, uuid)).toBe(uuid);
    }
  });

  it("refuses an unreadable logId rather than throwing", () => {
    const index = buildOwnedLogIndex([randomUUID()]);
    expect(resolveOwnedLogId(index, "not-a-log-id")).toBeUndefined();
    expect(resolveOwnedLogId(index, "")).toBeUndefined();
  });
});
