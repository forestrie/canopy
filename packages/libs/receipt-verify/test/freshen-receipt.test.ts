import { describe, expect, it } from "vitest";
import {
  consistentRoots,
  createSyncHasher,
  indexConsistencyProof,
  peakMMRIndexes,
  type NodeGetter,
} from "@forestrie/merklelog";
import { freshenReceipt } from "../src/freshen-receipt.js";
import { buildReceiptOffline } from "../src/build-receipt-offline.js";
import { verifyGrantReceiptOffline } from "../src/verify-grant-receipt-offline.js";
import { grantCommitmentHashFromGrant } from "../src/grant-commitment.js";
import { univocityLeafHash } from "../src/leaf-commitment.js";
import type { Grant } from "@forestrie/encoding";
import {
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
const MASSIF_HEIGHT = 3; // 4 leaves per massif (size 7)

/**
 * FOR-418 Phase 3 (plan-2607-32): freshen a stale receipt tile-free.
 *
 * A 4-leaf MMR (size 7). leaf1's receipt is made at size 3 (peak node 2). Growth
 * to size 7 BURIES node 2 into node 6 (via node 5). Freshening extends the path
 * [n0] → [n0, n5] using ONLY the checkpoint chain's consistency proof (no
 * tiles), re-signs against the latest checkpoint's peak receipt, and the result
 * verifies against the current state.
 *
 *   nodes: 0=leaf0 1=leaf1 2=H(3|n0|n1) 3=leaf2 4=leaf3 5=H(6|n3|n4) 6=H(7|n2|n5)
 *   peaks: size 3 -> [n2]; size 7 -> [n6]
 */
async function grantLeaf(grantData: Uint8Array, idFill: number) {
  const grant = grantWithData(LOG_ID, grantData);
  const idtimestampBe8 = new Uint8Array(8).fill(idFill);
  const inner = await grantCommitmentHashFromGrant(grant);
  const leafHash = await univocityLeafHash(idtimestampBe8, inner);
  return { grant, idtimestampBe8, leafHash };
}

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
  const leaf3 = await grantLeaf(new Uint8Array(64).fill(0xcc), 0x04);

  const n0 = leaf0.leafHash;
  const n1 = leaf1.leafHash;
  const n2 = await positionCommittedInteriorHash(3n, n0, n1);
  const n3 = leaf2.leafHash;
  const n4 = leaf3.leafHash;
  const n5 = await positionCommittedInteriorHash(6n, n3, n4);
  const n6 = await positionCommittedInteriorHash(7n, n2, n5);
  const nodes = [n0, n1, n2, n3, n4, n5, n6];

  const massif7 = buildV2MassifBytes({
    massifHeight: MASSIF_HEIGHT,
    massifIndex: 0,
    logHashes: nodes,
  });
  return { rootKeyPair, genesisCbor, leaf1, nodes, massif7 };
}

describe("freshenReceipt (FOR-418)", () => {
  it("freshens a buried receipt from size 3 to size 7 (tile-free) and it verifies", async () => {
    const fx = await buildFixture();
    const get: NodeGetter = (i) => fx.nodes[Number(i)]!;
    const hasher = await createSyncHasher();

    // --- old receipt at size 3 (leaf1's peak is node 2) ---
    const oldCheckpoint = buildV2CheckpointBytes({
      mmrSize: 3n,
      peakReceipts: [
        await signDetachedPeakReceipt(fx.rootKeyPair, fx.nodes[2]!),
      ],
    });
    const oldReceipt = buildReceiptOffline({
      massifBytes: fx.massif7,
      checkpointBytes: oldCheckpoint,
      mmrIndex: 1n,
    });
    // sanity: old path is [n0]
    // (leaf1 -> n2)

    // --- latest checkpoint at size 7 (single peak node 6) ---
    const latestCheckpoint = buildV2CheckpointBytes({
      mmrSize: 7n,
      peakReceipts: [
        await signDetachedPeakReceipt(fx.rootKeyPair, fx.nodes[6]!),
      ],
    });

    // --- consistency proof 3 -> 7 (paths for size-3 peaks, proven at size 7) ---
    const cp = indexConsistencyProof(get, 2n, 6n); // ifrom=2 (size3), ito=6 (size7)
    const aOld = peakMMRIndexes(2n).map(get); // [n2]
    const aLatest = peakMMRIndexes(6n).map(get); // [n6]
    const proven = await consistentRoots(hasher, 2n, aOld, cp.paths);
    const rightPeaks = aLatest.slice(proven.length);
    const link = {
      treeSize1: 3n,
      treeSize2: 7n,
      paths: cp.paths,
      rightPeaks,
    };

    const result = await freshenReceipt({
      oldReceiptBytes: oldReceipt,
      leafValue: fx.leaf1.leafHash,
      consistencyProofs: [link],
      accumulatorFrom: aOld,
      latestCheckpointBytes: latestCheckpoint,
    });

    expect(result.sealedSize).toBe(7n);
    // same signer (both checkpoints have no delegation cert here)
    expect(result.signerChanged).toBe(false);

    // the freshened receipt verifies against the CURRENT state
    const verified = await verifyGrantReceiptOffline({
      genesisCbor: fx.genesisCbor,
      receiptCbor: result.receipt,
      grant: fx.leaf1.grant,
      idtimestampBe8: fx.leaf1.idtimestampBe8,
    });
    expect(verified).toEqual({ ok: true, stage: "binding" });
  });

  it("flags a signer change when the latest checkpoint carries a different delegation", async () => {
    const fx = await buildFixture();
    const get: NodeGetter = (i) => fx.nodes[Number(i)]!;
    const hasher = await createSyncHasher();

    const oldCheckpoint = buildV2CheckpointBytes({
      mmrSize: 3n,
      peakReceipts: [
        await signDetachedPeakReceipt(fx.rootKeyPair, fx.nodes[2]!),
      ],
      delegationCert: new Uint8Array([1, 2, 3]),
    });
    const oldReceipt = buildReceiptOffline({
      massifBytes: fx.massif7,
      checkpointBytes: oldCheckpoint,
      mmrIndex: 1n,
    });
    const latestCheckpoint = buildV2CheckpointBytes({
      mmrSize: 7n,
      peakReceipts: [
        await signDetachedPeakReceipt(fx.rootKeyPair, fx.nodes[6]!),
      ],
      delegationCert: new Uint8Array([9, 9, 9]), // different signer
    });
    const cp = indexConsistencyProof(get, 2n, 6n);
    const aOld = peakMMRIndexes(2n).map(get);
    const aLatest = peakMMRIndexes(6n).map(get);
    const proven = await consistentRoots(hasher, 2n, aOld, cp.paths);
    const link = {
      treeSize1: 3n,
      treeSize2: 7n,
      paths: cp.paths,
      rightPeaks: aLatest.slice(proven.length),
    };

    const result = await freshenReceipt({
      oldReceiptBytes: oldReceipt,
      leafValue: fx.leaf1.leafHash,
      consistencyProofs: [link],
      accumulatorFrom: aOld,
      latestCheckpointBytes: latestCheckpoint,
    });
    expect(result.signerChanged).toBe(true);
  });

  it("fails closed when the leaf value does not match the chain", async () => {
    const fx = await buildFixture();
    const get: NodeGetter = (i) => fx.nodes[Number(i)]!;
    const hasher = await createSyncHasher();
    const oldCheckpoint = buildV2CheckpointBytes({
      mmrSize: 3n,
      peakReceipts: [
        await signDetachedPeakReceipt(fx.rootKeyPair, fx.nodes[2]!),
      ],
    });
    const oldReceipt = buildReceiptOffline({
      massifBytes: fx.massif7,
      checkpointBytes: oldCheckpoint,
      mmrIndex: 1n,
    });
    const latestCheckpoint = buildV2CheckpointBytes({
      mmrSize: 7n,
      peakReceipts: [
        await signDetachedPeakReceipt(fx.rootKeyPair, fx.nodes[6]!),
      ],
    });
    const cp = indexConsistencyProof(get, 2n, 6n);
    const aOld = peakMMRIndexes(2n).map(get);
    const aLatest = peakMMRIndexes(6n).map(get);
    const proven = await consistentRoots(hasher, 2n, aOld, cp.paths);
    const link = {
      treeSize1: 3n,
      treeSize2: 7n,
      paths: cp.paths,
      rightPeaks: aLatest.slice(proven.length),
    };
    await expect(
      freshenReceipt({
        oldReceiptBytes: oldReceipt,
        leafValue: new Uint8Array(32).fill(0xee), // wrong leaf
        consistencyProofs: [link],
        accumulatorFrom: aOld,
        latestCheckpointBytes: latestCheckpoint,
      }),
    ).rejects.toThrow(/does not recompute the latest accumulator peak/);
  });
});
