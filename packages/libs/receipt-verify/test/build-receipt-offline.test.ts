import { describe, expect, it } from "vitest";
import { encode as encodeCbor } from "cbor-x";
import {
  buildReceiptOffline,
  computeAccumulatorPeak,
} from "../src/build-receipt-offline.js";
import { parseReceipt } from "../src/parse-receipt.js";
import { verifyGrantReceiptOffline } from "../src/verify-grant-receipt-offline.js";
import { grantCommitmentHashFromGrant } from "../src/grant-commitment.js";
import { univocityLeafHash } from "../src/leaf-commitment.js";
import type { Grant } from "@forestrie/encoding";
import {
  buildDetachedPeakReceipt,
  buildGenesisCbor,
  generateP256KeyPair,
  grantWithData,
} from "./helpers/grant-receipt-fixture.js";
import {
  buildV2CheckpointBytes,
  buildV2MassifBytes,
  positionCommittedInteriorHash,
  signDetachedPeakReceipt,
} from "./helpers/massif-checkpoint-fixture.js";

const LOG_ID = "660e8400-e29b-41d4-a716-446655440001";
const MASSIF_HEIGHT = 3;

type GrantLeaf = {
  grant: Grant;
  idtimestampBe8: Uint8Array;
  leafHash: Uint8Array;
};

async function grantLeaf(
  grantData: Uint8Array,
  idFill: number,
): Promise<GrantLeaf> {
  const grant = grantWithData(LOG_ID, grantData);
  const idtimestampBe8 = new Uint8Array(8).fill(idFill);
  const inner = await grantCommitmentHashFromGrant(grant);
  const leafHash = await univocityLeafHash(idtimestampBe8, inner);
  return { grant, idtimestampBe8, leafHash };
}

/**
 * Fixture MMR (3 leaves, size 4):
 *   nodes: 0=leaf0, 1=leaf1, 2=H(3||n0||n1), 3=leaf2
 *   peaks at size 3: [n2]; peaks at size 4: [n2, n3]
 */
async function buildFixture() {
  const rootKeyPair = await generateP256KeyPair();
  const rootRaw = new Uint8Array(
    (await crypto.subtle.exportKey(
      "raw",
      rootKeyPair.publicKey,
    )) as ArrayBuffer,
  );
  const bootstrapKey = rootRaw.slice(1);
  const genesisCbor = buildGenesisCbor(bootstrapKey, LOG_ID);

  const leaf0 = await grantLeaf(new Uint8Array(64).fill(0xaa), 0x01);
  const leaf1 = await grantLeaf(bootstrapKey, 0x02);
  const leaf2 = await grantLeaf(new Uint8Array(64).fill(0xbb), 0x03);

  const n0 = leaf0.leafHash;
  const n1 = leaf1.leafHash;
  const n2 = await positionCommittedInteriorHash(3n, n0, n1);
  const n3 = leaf2.leafHash;

  const massifBytes = buildV2MassifBytes({
    massifHeight: MASSIF_HEIGHT,
    massifIndex: 0,
    logHashes: [n0, n1, n2, n3],
  });

  return {
    rootKeyPair,
    genesisCbor,
    leaf0,
    leaf1,
    leaf2,
    n0,
    n1,
    n2,
    n3,
    massifBytes,
  };
}

describe("buildReceiptOffline", () => {
  it("self-creates a receipt that passes offline verification (single peak)", async () => {
    const fx = await buildFixture();
    const checkpointBytes = buildV2CheckpointBytes({
      mmrSize: 3n,
      peakReceipts: [await signDetachedPeakReceipt(fx.rootKeyPair, fx.n2)],
    });

    const receiptCbor = buildReceiptOffline({
      massifBytes: fx.massifBytes,
      checkpointBytes,
      mmrIndex: 1n,
    });

    const parsed = parseReceipt(receiptCbor);
    expect(parsed.explicitPeak).toBeNull();
    expect(parsed.proof.mmrIndex).toBe(1n);
    expect(parsed.proof.path).toEqual([fx.n0]);

    const result = await verifyGrantReceiptOffline({
      genesisCbor: fx.genesisCbor,
      receiptCbor,
      grant: fx.leaf1.grant,
      idtimestampBe8: fx.leaf1.idtimestampBe8,
    });
    expect(result).toEqual({ ok: true, stage: "binding" });
  });

  it("selects the correct pre-signed peak receipt in a multi-peak accumulator", async () => {
    const fx = await buildFixture();
    const checkpointBytes = buildV2CheckpointBytes({
      mmrSize: 4n,
      peakReceipts: [
        await signDetachedPeakReceipt(fx.rootKeyPair, fx.n2),
        await signDetachedPeakReceipt(fx.rootKeyPair, fx.n3),
      ],
    });

    // leaf2 (mmrIndex 3) is its own peak: empty path, slot 1.
    const receipt3 = buildReceiptOffline({
      massifBytes: fx.massifBytes,
      checkpointBytes,
      mmrIndex: 3n,
    });
    expect(parseReceipt(receipt3).proof.path).toEqual([]);
    const result3 = await verifyGrantReceiptOffline({
      genesisCbor: fx.genesisCbor,
      receiptCbor: receipt3,
      grant: fx.leaf2.grant,
      idtimestampBe8: fx.leaf2.idtimestampBe8,
    });
    expect(result3).toEqual({ ok: true, stage: "binding" });

    // leaf0 commits to the first peak: path [n1], slot 0.
    const receipt0 = buildReceiptOffline({
      massifBytes: fx.massifBytes,
      checkpointBytes,
      mmrIndex: 0n,
    });
    expect(parseReceipt(receipt0).proof.path).toEqual([fx.n1]);
    const result0 = await verifyGrantReceiptOffline({
      genesisCbor: fx.genesisCbor,
      receiptCbor: receipt0,
      grant: fx.leaf0.grant,
      idtimestampBe8: fx.leaf0.idtimestampBe8,
    });
    expect(result0).toEqual({ ok: true, stage: "binding" });
  });

  it("verify-equivalence: derived and API-shaped receipts for the same leaf verify identically", async () => {
    // FOR-334 AC (plan-2607-15 §2): a self-derived receipt and an
    // API-issued receipt for the same leaf both pass
    // verifyGrantReceiptOffline with identical results. Deliberately NOT a
    // byte comparison — encoder variation is known-benign (FOR-370).
    const fx = await buildFixture();
    const checkpointBytes = buildV2CheckpointBytes({
      mmrSize: 3n,
      peakReceipts: [await signDetachedPeakReceipt(fx.rootKeyPair, fx.n2)],
    });

    const derived = buildReceiptOffline({
      massifBytes: fx.massifBytes,
      checkpointBytes,
      mmrIndex: 1n,
    });
    // API shape: the pre-signed peak receipt with the proof already spliced
    // at header 396, as canopy-api resolve-receipt emits it.
    const apiShaped = await buildDetachedPeakReceipt({
      signer: fx.rootKeyPair,
      peak: fx.n2,
      proof: { path: [fx.n0], mmrIndex: 1n },
    });

    const verifyInput = (receiptCbor: Uint8Array) => ({
      genesisCbor: fx.genesisCbor,
      receiptCbor,
      grant: fx.leaf1.grant,
      idtimestampBe8: fx.leaf1.idtimestampBe8,
    });
    const derivedResult = await verifyGrantReceiptOffline(verifyInput(derived));
    const apiResult = await verifyGrantReceiptOffline(verifyInput(apiShaped));
    expect(derivedResult).toEqual({ ok: true, stage: "binding" });
    expect(apiResult).toEqual(derivedResult);

    // Structural equivalence of the computed field (header 396 content).
    const parsedDerived = parseReceipt(derived);
    const parsedApi = parseReceipt(apiShaped);
    expect(parsedDerived.proof).toEqual(parsedApi.proof);
    expect(parsedDerived.explicitPeak).toBeNull();
    expect(parsedApi.explicitPeak).toBeNull();
  });

  it("rejects a receipt built from tampered massif content", async () => {
    const fx = await buildFixture();
    const checkpointBytes = buildV2CheckpointBytes({
      mmrSize: 3n,
      peakReceipts: [await signDetachedPeakReceipt(fx.rootKeyPair, fx.n2)],
    });

    const tampered = fx.massifBytes.slice();
    // Flip a bit in the sibling node (n0) log data — last 4 fields are nodes.
    tampered[tampered.length - 4 * 32] ^= 0x01;

    const receiptCbor = buildReceiptOffline({
      massifBytes: tampered,
      checkpointBytes,
      mmrIndex: 1n,
    });
    const result = await verifyGrantReceiptOffline({
      genesisCbor: fx.genesisCbor,
      receiptCbor,
      grant: fx.leaf1.grant,
      idtimestampBe8: fx.leaf1.idtimestampBe8,
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("signature");
  });

  it("throws when the checkpoint does not cover the entry", async () => {
    const fx = await buildFixture();
    const checkpointBytes = buildV2CheckpointBytes({
      mmrSize: 3n,
      peakReceipts: [await signDetachedPeakReceipt(fx.rootKeyPair, fx.n2)],
    });
    expect(() =>
      buildReceiptOffline({
        massifBytes: fx.massifBytes,
        checkpointBytes,
        mmrIndex: 3n,
      }),
    ).toThrow(/does not cover entry/);
  });

  it("throws when the checkpoint has no peak receipts", async () => {
    const fx = await buildFixture();
    const consistencyProof = encodeCbor([0n, 3n, [], []]);
    const noReceipts = encodeCbor([
      new Uint8Array(),
      new Map<number, unknown>([
        [396, new Map<number, unknown>([[-2, consistencyProof]])],
      ]),
      null,
      new Uint8Array(),
    ]);
    expect(() =>
      buildReceiptOffline({
        massifBytes: fx.massifBytes,
        checkpointBytes: new Uint8Array(noReceipts),
        mmrIndex: 1n,
      }),
    ).toThrow(/peak receipts/);
  });

  it("throws when the peak receipt slot is absent", async () => {
    const fx = await buildFixture();
    const checkpointBytes = buildV2CheckpointBytes({
      mmrSize: 3n,
      peakReceipts: [],
    });
    expect(() =>
      buildReceiptOffline({
        massifBytes: fx.massifBytes,
        checkpointBytes,
        mmrIndex: 1n,
      }),
    ).toThrow(/peak receipt slot/);
  });
});

describe("computeAccumulatorPeak (chain-anchored)", () => {
  it("matches the accumulator the contract would store at size 4", async () => {
    const fx = await buildFixture();
    const accumulator = [fx.n2, fx.n3];

    const p0 = await computeAccumulatorPeak({
      massifBytes: fx.massifBytes,
      mmrIndex: 0n,
      mmrSize: 4n,
    });
    expect(p0.peakIndex).toBe(0);
    expect(p0.peak).toEqual(accumulator[0]);

    const p3 = await computeAccumulatorPeak({
      massifBytes: fx.massifBytes,
      mmrIndex: 3n,
      mmrSize: 4n,
    });
    expect(p3.peakIndex).toBe(1);
    expect(p3.peak).toEqual(accumulator[1]);
  });

  it("supports an on-chain size lagging the local massif head", async () => {
    const fx = await buildFixture();
    const p1 = await computeAccumulatorPeak({
      massifBytes: fx.massifBytes,
      mmrIndex: 1n,
      mmrSize: 3n,
    });
    expect(p1.peakIndex).toBe(0);
    expect(p1.peak).toEqual(fx.n2);
  });

  it("detects tampered local content against the accumulator", async () => {
    const fx = await buildFixture();
    const tampered = fx.massifBytes.slice();
    tampered[tampered.length - 4 * 32] ^= 0x01;
    const p1 = await computeAccumulatorPeak({
      massifBytes: tampered,
      mmrIndex: 1n,
      mmrSize: 3n,
    });
    expect(p1.peak).not.toEqual(fx.n2);
  });

  it("throws when the entry is not yet anchored", async () => {
    const fx = await buildFixture();
    await expect(
      computeAccumulatorPeak({
        massifBytes: fx.massifBytes,
        mmrIndex: 3n,
        mmrSize: 3n,
      }),
    ).rejects.toThrow(/not covered by tree size/);
  });

  it("throws when local content does not reach the attested size", async () => {
    const fx = await buildFixture();
    await expect(
      computeAccumulatorPeak({
        massifBytes: fx.massifBytes,
        mmrIndex: 0n,
        mmrSize: 12n,
      }),
    ).rejects.toThrow(/does not cover the requested tree size/);
  });
});
