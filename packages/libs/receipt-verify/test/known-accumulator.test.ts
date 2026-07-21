import { describe, expect, it } from "vitest";
import { calculateRoot } from "@forestrie/merklelog";
import { grantCommitmentHashFromGrant } from "../src/grant-commitment.js";
import { parseReceipt } from "../src/parse-receipt.js";
import { univocityLeafHash } from "../src/leaf-commitment.js";
import { SubtleHasher } from "../src/subtle-hasher.js";
import {
  assertSnapshotBinding,
  decodeKnownAccumulator,
  encodeKnownAccumulator,
  verifyReceiptOfflineAgainstKnownAccumulator,
  type KnownAccumulator,
} from "../src/known-accumulator.js";
import { buildGrantReceiptFixture } from "./helpers/grant-receipt-fixture.js";

/** buildGrantReceiptFixture's receipt uses a DETACHED payload (COSE payload
 * is null; the peak is only the external signed content) — parseReceipt's
 * explicitPeak is therefore null for it, same as a real chain-anchored
 * receipt. Recompute the peak the same way verifyReceiptOfflineAgainstKnownAccumulator
 * does internally, to build a known-accumulator that legitimately contains it. */
async function recomputeFixturePeak(fx: {
  receiptCbor: Uint8Array;
  idtimestampBe8: Uint8Array;
  inner: Uint8Array;
}): Promise<Uint8Array> {
  const { proof } = parseReceipt(fx.receiptCbor);
  const leafIdx =
    proof.leafIndex !== undefined ? proof.leafIndex : proof.mmrIndex!;
  const leafHash = await univocityLeafHash(fx.idtimestampBe8, fx.inner);
  return calculateRoot(new SubtleHasher(), leafHash, proof, leafIdx);
}

describe("verifyReceiptOfflineAgainstKnownAccumulator", () => {
  it("verifies when the recomputed peak is in the known accumulator", async () => {
    const fx = await buildGrantReceiptFixture();
    const inner = await grantCommitmentHashFromGrant(fx.grant);
    const peak = await recomputeFixturePeak({ ...fx, inner });
    const result = await verifyReceiptOfflineAgainstKnownAccumulator({
      receiptCbor: fx.receiptCbor,
      idtimestampBe8: fx.idtimestampBe8,
      inner,
      accumulator: [peak],
      size: 2n,
    });
    expect(result).toEqual({ ok: true, stage: "binding" });
  });

  it("fails closed when the receipt leaf postdates the known accumulator size", async () => {
    const fx = await buildGrantReceiptFixture();
    const inner = await grantCommitmentHashFromGrant(fx.grant);
    const result = await verifyReceiptOfflineAgainstKnownAccumulator({
      receiptCbor: fx.receiptCbor,
      idtimestampBe8: fx.idtimestampBe8,
      inner,
      accumulator: [],
      size: 1n, // receipt leaf is mmrIndex 1n; 1n is not > 1n, so this is "postdates or equals"
    });
    expect(result).toEqual({
      ok: false,
      stage: "signature",
      reason: "receipt_newer_than_known_accumulator",
    });
  });

  it("rejects when the recomputed peak is not in the known accumulator", async () => {
    const fx = await buildGrantReceiptFixture();
    const inner = await grantCommitmentHashFromGrant(fx.grant);
    const result = await verifyReceiptOfflineAgainstKnownAccumulator({
      receiptCbor: fx.receiptCbor,
      idtimestampBe8: fx.idtimestampBe8,
      inner,
      accumulator: [new Uint8Array(32).fill(0xee)],
      size: 5n,
    });
    expect(result).toEqual({
      ok: false,
      stage: "signature",
      reason: "peak_not_in_known_accumulator",
    });
  });

  it("rejects a malformed receipt at the parse stage", async () => {
    const result = await verifyReceiptOfflineAgainstKnownAccumulator({
      receiptCbor: new Uint8Array([0x00]),
      idtimestampBe8: new Uint8Array(8),
      inner: new Uint8Array(32),
      accumulator: [],
      size: 10n,
    });
    expect(result).toEqual({
      ok: false,
      stage: "parse",
      reason: "receipt_malformed",
    });
  });
});

describe("known accumulator snapshot artifact", () => {
  const sample: KnownAccumulator = {
    version: 1,
    chainId: 84532n,
    univocity: new Uint8Array(20).fill(0xab),
    logId: new Uint8Array(32).fill(0xcd),
    size: 42n,
    accumulator: [new Uint8Array(32).fill(0x01), new Uint8Array(32).fill(0x02)],
    blockNumber: 123456n,
    blockHash: new Uint8Array(32).fill(0xef),
  };

  it("round-trips through canonical CBOR", () => {
    const decoded = decodeKnownAccumulator(encodeKnownAccumulator(sample));
    expect(decoded).toEqual(sample);
  });

  it("rejects a non-canonical / malformed snapshot", () => {
    expect(() => decodeKnownAccumulator(new Uint8Array([0xff]))).toThrow(
      /not canonical CBOR/,
    );
  });

  it("assertSnapshotBinding passes for the matching univocity/logId", () => {
    expect(() =>
      assertSnapshotBinding(sample, {
        univocity: "0x" + "ab".repeat(20),
        logId: "cd".repeat(32),
      }),
    ).not.toThrow();
  });

  it("assertSnapshotBinding rejects a mismatched univocity", () => {
    expect(() =>
      assertSnapshotBinding(sample, { univocity: "0x" + "11".repeat(20) }),
    ).toThrow(/bound to univocity/);
  });

  it("assertSnapshotBinding rejects a mismatched logId", () => {
    expect(() =>
      assertSnapshotBinding(sample, { logId: "11".repeat(32) }),
    ).toThrow(/bound to log/);
  });
});
