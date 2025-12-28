import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { encodeEntryId } from "../src/scrapi/entry-id";
import worker from "../src/index";
import type { Env } from "../src/index";

// Cast the test env to our Env type.
const testEnv = env as unknown as Env;

describe("SCRAPI flow", () => {
  // This test requires the SEQUENCED_CONTENT DO to be seeded with lookup data.
  // Skipping until we have proper DO test fixtures for cross-worker RPC.
  it.skip("query-registration-status redirects to permanent receipt URL", async () => {
    const logId = "de305d54-75b4-431b-adb2-eb6b9e546014";
    const contentHash = "ab".repeat(32);

    const massifHeight = 14;
    const idtimestampHex = "0102030405060708";
    const mmrIndex = "42";

    // TODO: Seed the SEQUENCED_CONTENT DO with lookup data.
    // The old KV-based RANGER_MMR_INDEX is replaced by the SequencedContent DO.

    const expectedEntryId = encodeEntryId({
      idtimestamp: BigInt(`0x${idtimestampHex}`),
      mmrIndex,
    });

    const request = new Request(
      `http://localhost/logs/${logId}/entries/${contentHash}`,
    );
    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(
      `http://localhost/logs/${logId}/${massifHeight}/entries/${expectedEntryId}/receipt`,
    );
  });

  it("resolve-receipt returns a COSE_Sign1 receipt with an attached proof", async () => {
    const logId = "de305d54-75b4-431b-adb2-eb6b9e546014";
    const massifHeight = 3;

    // Entry id encodes (idtimestamp, mmrIndex). We only use mmrIndex for receipt lookup.
    const idtimestamp = 0x0102030405060708n;
    const mmrIndex = 0n;
    const entryId = encodeEntryId({ idtimestamp, mmrIndex });

    // --- Build minimal v2 massif + checkpoint fixtures in R2_MMRS ---

    // COSE / MMRIVER constants
    const SEAL_PEAK_RECEIPTS_LABEL = -65931;

    // Minimal pre-signed peak receipt (detached payload).
    const emptyBstr = new Uint8Array();
    const emptySig = new Uint8Array();
    const peakReceipt: any[] = [
      emptyBstr,
      new Map<number, unknown>(),
      null,
      emptySig,
    ];
    const peakReceiptBytes = encodeCbor(peakReceipt) as Uint8Array;

    // Checkpoint payload: CBOR map with key 1 => mmrSize.
    const mmrSize = 3n;
    const state = new Map<number, unknown>([[1, mmrSize]]);
    const stateBytes = encodeCbor(state) as Uint8Array;

    // Checkpoint COSE_Sign1: unprotected contains the peak receipts.
    const checkpointUnprotected = new Map<number, unknown>([
      [SEAL_PEAK_RECEIPTS_LABEL, [peakReceiptBytes]],
    ]);
    const checkpoint: any[] = [
      emptyBstr,
      checkpointUnprotected,
      stateBytes,
      emptySig,
    ];
    const checkpointBytes = encodeCbor(checkpoint) as Uint8Array;

    // Massif blob layout (v2):
    // fixed header (256) + index header (32) + v2 index data + peak stack (2048) + log data
    const VALUE_BYTES = 32;
    const RESERVED_HEADER_SLOTS = 7;
    const INDEX_HEADER_BYTES = 32;
    const MAX_MMR_HEIGHT = 64;

    const BLOOM_BITS_PER_ELEMENT_V1 = 10;
    const BLOOM_FILTERS = 4;
    const BLOOM_HEADER_BYTES_V1 = 32;

    const URKLE_FRONTIER_STATE_V1_BYTES = 544;
    const URKLE_LEAF_RECORD_BYTES = 128;
    const URKLE_NODE_RECORD_BYTES = 64;

    const leafCount = 1 << (massifHeight - 1);
    const mBits = BLOOM_BITS_PER_ELEMENT_V1 * leafCount;
    const bitsetBytes = Math.ceil(mBits / 8);
    const bloomRegionBytes =
      BLOOM_HEADER_BYTES_V1 + BLOOM_FILTERS * bitsetBytes;
    const bloomBitsetsBytes = bloomRegionBytes - BLOOM_HEADER_BYTES_V1;

    const leafTableBytes = leafCount * URKLE_LEAF_RECORD_BYTES;
    const nodeStoreBytes = (2 * leafCount - 1) * URKLE_NODE_RECORD_BYTES;
    const indexDataBytes =
      bloomBitsetsBytes +
      URKLE_FRONTIER_STATE_V1_BYTES +
      leafTableBytes +
      nodeStoreBytes;

    const fixedHeaderEnd = VALUE_BYTES + VALUE_BYTES * RESERVED_HEADER_SLOTS; // 256
    const trieHeaderEnd = fixedHeaderEnd + INDEX_HEADER_BYTES; // 288
    const peakStackStart = trieHeaderEnd + indexDataBytes;
    const logStart = peakStackStart + MAX_MMR_HEIGHT * VALUE_BYTES;

    const logEntries = 3; // indices 0..2
    const massifBytes = new Uint8Array(logStart + logEntries * VALUE_BYTES);
    const view = new DataView(massifBytes.buffer);

    // Massif start header fields
    view.setBigUint64(8, 0n, false); // lastID
    view.setUint16(21, 2, false); // version
    view.setUint32(23, 1, false); // commitmentEpoch
    massifBytes[27] = massifHeight; // massifHeight
    view.setUint32(28, 0, false); // massifIndex

    // Log data (node hashes)
    const node0 = new Uint8Array(VALUE_BYTES).fill(0xaa);
    const node1 = new Uint8Array(VALUE_BYTES).fill(0xbb);
    const node2 = new Uint8Array(VALUE_BYTES).fill(0xcc);
    massifBytes.set(node0, logStart + 0 * VALUE_BYTES);
    massifBytes.set(node1, logStart + 1 * VALUE_BYTES);
    massifBytes.set(node2, logStart + 2 * VALUE_BYTES);

    const objectIndex = "0000000000000000";
    const checkpointKey = `v2/merklelog/checkpoints/${massifHeight}/${logId}/${objectIndex}.sth`;
    const massifKey = `v2/merklelog/massifs/${massifHeight}/${logId}/${objectIndex}.log`;

    await proveEnvHasMMRSBucket(testEnv);
    await testEnv.R2_MMRS.put(checkpointKey, checkpointBytes);
    await testEnv.R2_MMRS.put(massifKey, massifBytes);

    // --- Request receipt ---
    const request = new Request(
      `http://localhost/logs/${logId}/${massifHeight}/entries/${entryId}/receipt`,
    );
    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/scitt-receipt+cbor",
    );

    const decoded = decodeCbor(
      new Uint8Array(await response.arrayBuffer()),
    ) as any;
    expect(Array.isArray(decoded)).toBe(true);
    expect(decoded).toHaveLength(4);

    const unprotected = decoded[1];
    const proofs = headerGet(unprotected, 396);
    const inclusionProofs = headerGet(proofs, -1);

    expect(Array.isArray(inclusionProofs)).toBe(true);
    expect(inclusionProofs).toHaveLength(1);

    const p0 = inclusionProofs[0];
    expect(headerGet(p0, 1)).toBe(0n);

    const path = headerGet(p0, 2);
    expect(Array.isArray(path)).toBe(true);
    expect(path).toHaveLength(1);
    expect(path[0]).toEqual(node1);
  });
});

function headerGet(objOrMap: any, key: number): any {
  if (objOrMap instanceof Map) return objOrMap.get(key);
  if (typeof objOrMap !== "object" || objOrMap === null) return undefined;
  return (objOrMap as any)[key] ?? (objOrMap as any)[String(key)];
}

async function proveEnvHasMMRSBucket(e: Env): Promise<void> {
  if (!("R2_MMRS" in e)) {
    throw new Error(
      "test env missing R2_MMRS binding (run wrangler types / update worker-configuration.d.ts)",
    );
  }
}
