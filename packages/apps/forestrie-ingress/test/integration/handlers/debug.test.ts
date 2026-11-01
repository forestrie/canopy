/**
 * GET /queue/debug/recent reports leaf indices as decimal
 * strings: they are uint64 `bigint` values, which JSON numbers cannot carry
 * exactly and `Response.json` cannot serialise.
 */

import { describe, expect, it } from "vitest";
import worker from "../../../src/index";
import { testEnv, getStub, DEFAULT_SHARD } from "./fixture";

describe("/queue/debug/recent", () => {
  it("reports a sequenced leaf index above 2^53 as a decimal string", async () => {
    const stub = getStub(DEFAULT_SHARD);
    const logId = new Uint8Array(16).fill(0x91);
    const { seq } = await stub.enqueue(
      logId.buffer,
      new Uint8Array(32).fill(0x91).buffer,
    );
    const leafIndex = (1n << 53n) + 1n;
    await stub.ackFirst(logId.buffer, seq, 1, leafIndex, 24);

    const response = await worker.fetch(
      new Request(`http://localhost/queue/debug/recent?shard=${DEFAULT_SHARD}`),
      testEnv,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entries: { leafIndex: string | null }[];
    };
    expect(body.entries[0]).toMatchObject({
      leafIndex: leafIndex.toString(),
      sequenced: true,
    });
  });
});
