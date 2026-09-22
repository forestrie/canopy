/**
 * ADR-0066 D1 as amended (FOR-568): the sealed size of a stored checkpoint is
 * the SIGNED `tree-size-2` in its PROTECTED header (label -65933). A stored
 * `.sth` without that label carries no size any signature covers, so
 * `getCheckpointFromStorage` treats it the same as one with no consistency
 * proof at all and returns null. These two cases differ only in the presence
 * of the label: the consistency proof under the unprotected header is
 * identical in both.
 *
 * A THIRD case — a protected header that IS present but is not
 * deterministically encoded (ADR-0066 D9) — is not the same as either: it is
 * a sealer-side defect, not a checkpoint that is simply not sealed yet.
 * `getCheckpointFromStorage` used to fold it into the same `null`
 * (review finding O3); it now throws instead, see the last test below.
 */
import { encodeCborDeterministic } from "@forestrie/encoding";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getCheckpointFromStorage } from "../src/scrapi/checkpoint-from-storage.js";
import {
  encodePeakReceiptCoseSign1,
  mmrsCheckpointKey,
  putMmrsFixture,
} from "./helpers/mmrs-r2-fixture.js";

const MASSIF_HEIGHT = 3;

function proveEnvHasMMRSBucket(e: unknown): asserts e is { R2_MMRS: R2Bucket } {
  if (!e || typeof e !== "object" || !("R2_MMRS" in e)) {
    throw new Error("test env missing R2_MMRS binding");
  }
}

const placeholderPeak = encodePeakReceiptCoseSign1(
  new Uint8Array(),
  new Map(),
  new Uint8Array(),
);
const logHashes = [0xaa, 0xbb, 0xcc].map((b) => new Uint8Array(32).fill(b));

describe("getCheckpointFromStorage requires the signed tree-size-2 (ADR-0066 D1 as amended)", () => {
  it("returns the signed size when the protected header carries label -65933", async () => {
    proveEnvHasMMRSBucket(env);
    const logId = crypto.randomUUID();
    await putMmrsFixture(env.R2_MMRS, {
      logId,
      massifHeight: MASSIF_HEIGHT,
      mmrSize: 3n,
      logHashes,
      peakReceipts: [placeholderPeak],
    });

    const state = await getCheckpointFromStorage(logId, 0, {
      r2Mmrs: env.R2_MMRS,
      massifHeight: MASSIF_HEIGHT,
    });
    expect(state).toEqual({ signedTreeSize2: 3n });
  });

  it("rejects a checkpoint whose protected header carries no -65933 label", async () => {
    proveEnvHasMMRSBucket(env);
    const logId = crypto.randomUUID();
    await putMmrsFixture(env.R2_MMRS, {
      logId,
      massifHeight: MASSIF_HEIGHT,
      mmrSize: 3n,
      omitSignedTreeSize2: true,
      logHashes,
      peakReceipts: [placeholderPeak],
    });

    // The consistency proof is present and still declares tree-size-2 = 3.
    // Nothing signs that value, so there is no size to return.
    const state = await getCheckpointFromStorage(logId, 0, {
      r2Mmrs: env.R2_MMRS,
      massifHeight: MASSIF_HEIGHT,
    });
    expect(state).toBeNull();
  });

  it("throws — does not silently return null — when the stored protected header is not deterministically encoded (ADR-0066 D9, review finding O3)", async () => {
    proveEnvHasMMRSBucket(env);
    const logId = crypto.randomUUID();

    // The sealer's canonical header is `{1: -7, 395: 3, -65933: 8}`
    // (`a3012619018b033a0001018c08`). This vector carries the identical
    // three pairs in REVERSE key order — out of canonical order, which
    // RFC 8949 §4.2 / ADR-0066 D9 reject. Shared with the
    // "reject/keys-reversed" row in
    // packages/shared/encoding/src/protected-header-conformance.test.ts.
    const malformedProtected = Uint8Array.from(
      Buffer.from("a33a0001018c0819018b030126", "hex"),
    );
    const consistencyProof = encodeCborDeterministic([0n, 8n, [], []]);
    const checkpointUnprotected = new Map<number, unknown>([
      [396, new Map<number, unknown>([[-2, consistencyProof]])],
      [-65931, [placeholderPeak]],
    ]);
    const checkpointBytes = encodeCborDeterministic([
      malformedProtected,
      checkpointUnprotected,
      null,
      new Uint8Array(),
    ]) as Uint8Array;

    await env.R2_MMRS.put(
      mmrsCheckpointKey(logId, MASSIF_HEIGHT, 0n),
      checkpointBytes,
    );

    await expect(
      getCheckpointFromStorage(logId, 0, {
        r2Mmrs: env.R2_MMRS,
        massifHeight: MASSIF_HEIGHT,
      }),
    ).rejects.toThrow(/out of canonical order/);
  });
});
