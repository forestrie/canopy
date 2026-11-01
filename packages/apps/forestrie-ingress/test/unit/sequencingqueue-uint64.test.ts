/**
 * SequencingQueue leaf indices as uint64.
 *
 * arbor's ranger acks `firstLeafIndex` as a Go `uint64`; the queue must
 * record and return every leaf index exactly, including above 2^53 (where a
 * JS `number` loses precision) and above 2^63 (where a SQLite `INTEGER`
 * cannot hold it). No massif index is stored; readers derive it (FOR-620).
 */

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SequencingQueue } from "../../src/durableobjects/sequencingqueue";
import { getStub, testEnv } from "./sequencingqueue-fixture";

const UINT64_MAX = (1n << 64n) - 1n;

/** The untyped namespace stub `runInDurableObject` needs, by DO name. */
function namespaceStub(name: string) {
  const ns = testEnv.SEQUENCING_QUEUE;
  return ns.get(ns.idFromName(name));
}

/** Enqueue `n` entries with distinct content hashes; return hashes and seqLo. */
async function enqueueN(
  stub: ReturnType<typeof getStub>,
  logId: ArrayBuffer,
  n: number,
  tag: number,
): Promise<{ seqLo: number; hashes: ArrayBuffer[] }> {
  const hashes: ArrayBuffer[] = [];
  let seqLo = 0;
  for (let i = 0; i < n; i++) {
    const hash = new Uint8Array(32).fill(tag);
    hash[31] = i;
    const { seq } = await stub.enqueue(logId, hash.buffer);
    if (i === 0) seqLo = seq;
    hashes.push(hash.buffer);
  }
  return { seqLo, hashes };
}

describe("SequencingQueue uint64 leaf indices", () => {
  it.each([
    ["2^53+1", (1n << 53n) + 1n, 24],
    // `1 << 31` is negative and `1 << 32 === 1` as JS numbers.
    ["3*2^31+5 at height 31", 3n * (1n << 31n) + 5n, 31],
    ["5*2^32+7 at height 32", 5n * (1n << 32n) + 7n, 32],
    ["2^63", 1n << 63n, 32],
    ["2^64-2", UINT64_MAX - 1n, 32],
  ])("records and resolves leaf index %s exactly", async (_, first, h) => {
    const stub = getStub(`uint64-roundtrip-${first}`);
    const logId = new Uint8Array(16).fill(0x61).buffer;
    const { seqLo, hashes } = await enqueueN(stub, logId, 2, 0x61);

    const { acked } = await stub.ackFirst(logId, seqLo, 2, first, h);
    expect(acked).toBe(2);

    for (let i = 0; i < 2; i++) {
      const leafIndex = first + BigInt(i);
      expect(await stub.resolveContent(hashes[i])).toEqual({ leafIndex });
    }
  });
});

describe("SequencingQueue retention with uint64 leaf indices", () => {
  // Height 1: 1 leaf per massif, so retainedEntryCount(1) keeps 4 leaves
  // behind the newest.
  it.each([
    ["255 -> 256", 252n],
    ["2^32-1 -> 2^32", (1n << 32n) - 5n],
  ])("keeps the newest leaves across the %s boundary", async (_, first) => {
    const stub = getStub(`uint64-retention-${first}`);
    const logId = new Uint8Array(16).fill(0x62).buffer;
    const { seqLo, hashes } = await enqueueN(stub, logId, 10, 0x62);

    await stub.ackFirst(logId, seqLo, 10, first, 1);

    // Newest is first+9; leaves below first+9-4 are dropped.
    for (let i = 0; i < 10; i++) {
      const resolved = await stub.resolveContent(hashes[i]);
      if (i < 5) expect(resolved).toBeNull();
      else expect(resolved?.leafIndex).toBe(first + BigInt(i));
    }
  });
});

describe("SequencingQueue uint64 storage guards", () => {
  it("rejects an INTEGER leaf_index written to storage", async () => {
    const name = "uint64-trigger";
    const stub = getStub(name);
    const logId = new Uint8Array(16).fill(0x63).buffer;
    await stub.enqueue(logId, new Uint8Array(32).fill(0x63).buffer);

    await runInDurableObject(namespaceStub(name), async (_, state) => {
      expect(() =>
        state.storage.sql.exec("UPDATE queue_entries SET leaf_index = 5"),
      ).toThrow(/8-byte big-endian BLOB/);
    });
  });

  it("refuses storage created with an INTEGER leaf_index column", async () => {
    const name = "uint64-old-schema";
    // Assert inside the DO: an error escaping over RPC breaks the pool's
    // per-test isolated storage.
    await runInDurableObject(
      namespaceStub(name),
      async (instance: SequencingQueue, state) => {
        state.storage.sql.exec(`
        CREATE TABLE queue_entries (
          seq INTEGER PRIMARY KEY, log_id BLOB NOT NULL,
          content_hash BLOB NOT NULL, extra0 BLOB, extra1 BLOB,
          extra2 BLOB, extra3 BLOB, visible_after INTEGER,
          attempts INTEGER NOT NULL DEFAULT 0, enqueued_at INTEGER NOT NULL,
          leaf_index INTEGER DEFAULT NULL, massif_index INTEGER DEFAULT NULL,
          acked_at INTEGER DEFAULT NULL
        )`);
        await expect(instance.stats()).rejects.toThrow(/reset this queue/);
      },
    );
  });

  it("marks nothing sequenced when an ack fails part way through", async () => {
    const name = "uint64-atomic-ack";
    const stub = getStub(name);
    const logId = new Uint8Array(16).fill(0x64).buffer;
    const { seqLo } = await enqueueN(stub, logId, 2, 0x64);

    // Assert inside the DO: an error escaping over RPC breaks the pool's
    // per-test isolated storage. The second leaf, 2^64, cannot be encoded.
    await runInDurableObject(
      namespaceStub(name),
      async (instance: SequencingQueue, state) => {
        await expect(
          instance.ackFirst(logId, seqLo, 2, UINT64_MAX, 40),
        ).rejects.toThrow();
        const sequenced = state.storage.sql
          .exec<{
            n: number;
          }>(
            "SELECT COUNT(*) AS n FROM queue_entries WHERE leaf_index IS NOT NULL",
          )
          .toArray()[0].n;
        expect(sequenced).toBe(0);
        expect((await instance.stats()).pending).toBe(2);
      },
    );
  });
});
