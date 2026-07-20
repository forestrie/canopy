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
import { parseReceipt } from "../src/parse-receipt.js";
import { verifyGrantReceiptOffline } from "../src/verify-grant-receipt-offline.js";
import { grantCommitmentHashFromGrant } from "../src/grant-commitment.js";
import { univocityLeafHash } from "../src/leaf-commitment.js";
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
 *   peaks: size 3 -> [n2]; size 4 -> [n2, n3]; size 7 -> [n6]
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
  return { rootKeyPair, genesisCbor, leaf1, leaf2, nodes, massif7 };
}

/**
 * An 8-leaf MMR (size 15, single peak n14), spanning two massif-height-3
 * massifs. Used to exercise a MULTI-LINK chain: 3 -> 7 -> 15.
 *
 *   n0..n1 leaves; n2=H(3|n0|n1); n3..n4 leaves; n5=H(6|n3|n4); n6=H(7|n2|n5);
 *   n7..n8 leaves; n9=H(10|n7|n8); n10..n11 leaves; n12=H(13|n10|n11);
 *   n13=H(14|n9|n12); n14=H(15|n6|n13)
 */
async function buildFixture15() {
  const rootKeyPair = await generateP256KeyPair();
  const rootRaw = new Uint8Array(
    (await crypto.subtle.exportKey(
      "raw",
      rootKeyPair.publicKey,
    )) as ArrayBuffer,
  );
  const bootstrapKey = rootRaw.slice(1);
  const genesisCbor = buildGenesisCbor(bootstrapKey, LOG_ID);

  const leaves = [];
  for (let i = 0; i < 8; i++) {
    // leaf1 is the genesis-anchored grant (commits the bootstrap key).
    const data = i === 1 ? bootstrapKey : new Uint8Array(64).fill(0xa0 + i);
    leaves.push(await grantLeaf(data, 0x10 + i));
  }
  const h = leaves.map((l) => l.leafHash);
  const n2 = await positionCommittedInteriorHash(3n, h[0]!, h[1]!);
  const n5 = await positionCommittedInteriorHash(6n, h[2]!, h[3]!);
  const n6 = await positionCommittedInteriorHash(7n, n2, n5);
  const n9 = await positionCommittedInteriorHash(10n, h[4]!, h[5]!);
  const n12 = await positionCommittedInteriorHash(13n, h[6]!, h[7]!);
  const n13 = await positionCommittedInteriorHash(14n, n9, n12);
  const n14 = await positionCommittedInteriorHash(15n, n6, n13);
  // mmr indices 0..14
  const nodes = [
    h[0]!,
    h[1]!,
    n2,
    h[2]!,
    h[3]!,
    n5,
    n6,
    h[4]!,
    h[5]!,
    n9,
    h[6]!,
    h[7]!,
    n12,
    n13,
    n14,
  ];
  // The old receipt at size 3 only needs massif 0 (indices 0..6).
  const massif0 = buildV2MassifBytes({
    massifHeight: MASSIF_HEIGHT,
    massifIndex: 0,
    logHashes: nodes.slice(0, 7),
  });
  return { rootKeyPair, genesisCbor, leaf1: leaves[1]!, nodes, massif0 };
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

    // the freshened receipt verifies against the CURRENT state
    const verified = await verifyGrantReceiptOffline({
      genesisCbor: fx.genesisCbor,
      receiptCbor: result.receipt,
      grant: fx.leaf1.grant,
      idtimestampBe8: fx.leaf1.idtimestampBe8,
    });
    expect(verified).toEqual({ ok: true, stage: "binding" });
  });

  it("freshens a leaf whose old peak was a RIGHT peak (ordinal != mmr index)", async () => {
    // leaf2 lives at MMR index 3 (ordinal 2). At size 4 the accumulator is
    // [n2, n3] and leaf2 IS the right peak n3 (path []). Growth to size 7 buries
    // it: fresh path [n4, n2], drawn from BOTH size-4 peaks' consistency paths.
    const fx = await buildFixture();
    const get: NodeGetter = (i) => fx.nodes[Number(i)]!;
    const hasher = await createSyncHasher();

    const oldCheckpoint = buildV2CheckpointBytes({
      mmrSize: 4n,
      peakReceipts: [
        await signDetachedPeakReceipt(fx.rootKeyPair, fx.nodes[2]!),
        await signDetachedPeakReceipt(fx.rootKeyPair, fx.nodes[3]!),
      ],
    });
    const oldReceipt = buildReceiptOffline({
      massifBytes: fx.massif7,
      checkpointBytes: oldCheckpoint,
      mmrIndex: 3n,
    });
    const latestCheckpoint = buildV2CheckpointBytes({
      mmrSize: 7n,
      peakReceipts: [
        await signDetachedPeakReceipt(fx.rootKeyPair, fx.nodes[6]!),
      ],
    });

    const cp = indexConsistencyProof(get, 3n, 6n); // size4 -> size7
    const aOld = peakMMRIndexes(3n).map(get); // [n2, n3]
    const aLatest = peakMMRIndexes(6n).map(get); // [n6]
    const proven = await consistentRoots(hasher, 3n, aOld, cp.paths);
    const link = {
      treeSize1: 4n,
      treeSize2: 7n,
      paths: cp.paths,
      rightPeaks: aLatest.slice(proven.length),
    };

    const result = await freshenReceipt({
      oldReceiptBytes: oldReceipt,
      leafValue: fx.leaf2.leafHash,
      consistencyProofs: [link],
      accumulatorFrom: aOld,
      latestCheckpointBytes: latestCheckpoint,
    });

    expect(result.sealedSize).toBe(7n);
    // the emitted path is exactly the size-7 inclusion path for MMR index 3.
    const { proof } = parseReceipt(result.receipt);
    expect(proof.mmrIndex).toBe(3n);
    expect(proof.path).toEqual([fx.nodes[4]!, fx.nodes[2]!]);
  });

  it("freshens across a MULTI-LINK chain (3 -> 7 -> 15) and it verifies", async () => {
    const fx = await buildFixture15();
    const get: NodeGetter = (i) => fx.nodes[Number(i)]!;
    const hasher = await createSyncHasher();

    const oldCheckpoint = buildV2CheckpointBytes({
      mmrSize: 3n,
      peakReceipts: [
        await signDetachedPeakReceipt(fx.rootKeyPair, fx.nodes[2]!),
      ],
    });
    const oldReceipt = buildReceiptOffline({
      massifBytes: fx.massif0,
      checkpointBytes: oldCheckpoint,
      mmrIndex: 1n,
    });
    const latestCheckpoint = buildV2CheckpointBytes({
      mmrSize: 15n,
      peakReceipts: [
        await signDetachedPeakReceipt(fx.rootKeyPair, fx.nodes[14]!),
      ],
    });

    // link 3 -> 7
    const cp1 = indexConsistencyProof(get, 2n, 6n);
    const a3 = peakMMRIndexes(2n).map(get); // [n2]
    const a7 = peakMMRIndexes(6n).map(get); // [n6]
    const proven1 = await consistentRoots(hasher, 2n, a3, cp1.paths);
    const link1 = {
      treeSize1: 3n,
      treeSize2: 7n,
      paths: cp1.paths,
      rightPeaks: a7.slice(proven1.length),
    };
    // link 7 -> 15
    const cp2 = indexConsistencyProof(get, 6n, 14n);
    const a15 = peakMMRIndexes(14n).map(get); // [n14]
    const proven2 = await consistentRoots(hasher, 6n, a7, cp2.paths);
    const link2 = {
      treeSize1: 7n,
      treeSize2: 15n,
      paths: cp2.paths,
      rightPeaks: a15.slice(proven2.length),
    };

    const result = await freshenReceipt({
      oldReceiptBytes: oldReceipt,
      leafValue: fx.leaf1.leafHash,
      consistencyProofs: [link1, link2],
      accumulatorFrom: a3,
      latestCheckpointBytes: latestCheckpoint,
    });

    expect(result.sealedSize).toBe(15n);
    const verified = await verifyGrantReceiptOffline({
      genesisCbor: fx.genesisCbor,
      receiptCbor: result.receipt,
      grant: fx.leaf1.grant,
      idtimestampBe8: fx.leaf1.idtimestampBe8,
    });
    expect(verified).toEqual({ ok: true, stage: "binding" });
  });

  it("rejects a chain whose endpoint does not match the checkpoint's sealed size", async () => {
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
    // The link reaches size 7, but the checkpoint we borrow from sealed size 4.
    const mismatchedCheckpoint = buildV2CheckpointBytes({
      mmrSize: 4n,
      peakReceipts: [
        await signDetachedPeakReceipt(fx.rootKeyPair, fx.nodes[2]!),
        await signDetachedPeakReceipt(fx.rootKeyPair, fx.nodes[3]!),
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
        leafValue: fx.leaf1.leafHash,
        consistencyProofs: [link],
        accumulatorFrom: aOld,
        latestCheckpointBytes: mismatchedCheckpoint,
      }),
    ).rejects.toThrow(/ends at size 7 but the checkpoint sealed size 4/);
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
