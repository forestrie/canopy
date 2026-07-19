/**
 * Burial-bundle fixture (FOR-368 Phase 4, plan-2607-29): an 8-leaf MMR
 * whose early receipt peak (node 2, sealed at size 3) is BURIED by later
 * growth, plus the retained checkpoint chain that proves it forward —
 * sth(0→3) → sth(3→7) → sth(7→10) → sth(10→15) (ADR-0056 entry-boundary
 * bases for 2-leaf massifs; 3→10 exercises a genuine right-peak link).
 *
 * Leaves are the KAT-39 rule `H(BE8(mmrIndex))`, so the tree is fully
 * deterministic; only the signing key is generated (its public half is
 * frozen in the golden manifest).
 */
import {
  encodeCborDeterministic,
  encodeSigStructure,
} from "@forestrie/encoding";
import {
  consistentRoots,
  indexConsistencyProof,
  indexHeight,
  mmrIndex,
  peakMMRIndexes,
} from "@forestrie/merklelog";
import { accumulatorPayload } from "../../src/checkpoint-chain.js";
import { SubtleHasher } from "../../src/subtle-hasher.js";

const VDS_COSE_RECEIPT_PROOFS_TAG = 396;

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

function be8(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n);
  return out;
}

async function addLeaf(all: Uint8Array[], leaf: Uint8Array): Promise<void> {
  all.push(leaf);
  let g = 0;
  while (indexHeight(BigInt(all.length)) > g) {
    const right = all[all.length - 1]!;
    const left = all[all.length - (2 ** (g + 1) - 1) - 1]!;
    all.push(await sha256(be8(BigInt(all.length + 1)), left, right));
    g += 1;
  }
}

async function sign(
  keyPair: CryptoKeyPair,
  protectedBstr: Uint8Array,
  detachedPayload: Uint8Array,
): Promise<Uint8Array> {
  const sigStructure = encodeSigStructure(
    protectedBstr,
    new Uint8Array(0),
    detachedPayload,
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      sigStructure.buffer.slice(
        sigStructure.byteOffset,
        sigStructure.byteOffset + sigStructure.byteLength,
      ) as ArrayBuffer,
    ),
  );
}

export type BurialBundleFixture = {
  /** Retained chain in ascending order: 0→3, 3→7, 7→10, 10→15. */
  checkpoints: Uint8Array[];
  /** Old-era peak receipt: leaf mmrIndex 1, detached peak = node 2. */
  receiptCbor: Uint8Array;
  /** Leaf value the receipt's proof path starts from: H(BE8(1)). */
  leafHash: Uint8Array;
  leafMmrIndex: bigint;
  /** The buried peak the receipt commits to (node 2). */
  buriedPeak: Uint8Array;
  /** Final accumulator at size 15 (single peak, node 14). */
  finalAccumulator: Uint8Array[];
  /** Signer public key as raw x||y (64 bytes) — frozen in the manifest. */
  publicKeyXy: Uint8Array;
  keyPair: CryptoKeyPair;
};

export async function buildBurialBundleFixture(): Promise<BurialBundleFixture> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer,
  );
  const publicKeyXy = raw.slice(1);

  const nodes: Uint8Array[] = [];
  for (let leaf = 0n; leaf < 8n; leaf++) {
    await addLeaf(nodes, await sha256(be8(mmrIndex(leaf))));
  }
  const getHash = (i: bigint) => nodes[Number(i)]!;
  const peaksAt = (lastIndex: bigint) =>
    peakMMRIndexes(lastIndex).map(getHash);

  const hasher = new SubtleHasher();
  const protectedBstr = encodeCborDeterministic(new Map([[1, -7]]));

  const buildCheckpoint = async (
    sizeFrom: bigint,
    sizeTo: bigint,
  ): Promise<Uint8Array> => {
    const accumulatorTo = peaksAt(sizeTo - 1n);
    let paths: Uint8Array[][] = [];
    let rightPeaks = accumulatorTo;
    if (sizeFrom > 0n) {
      const cp = indexConsistencyProof(getHash, sizeFrom - 1n, sizeTo - 1n);
      paths = cp.paths;
      const proven = await consistentRoots(
        hasher,
        sizeFrom - 1n,
        peaksAt(sizeFrom - 1n),
        paths,
      );
      rightPeaks = accumulatorTo.slice(proven.length);
    }
    const proofBstr = encodeCborDeterministic([
      sizeFrom,
      sizeTo,
      paths,
      rightPeaks,
    ]);
    const sig = await sign(
      keyPair,
      protectedBstr,
      accumulatorPayload(accumulatorTo),
    );
    return encodeCborDeterministic([
      protectedBstr,
      new Map<number, unknown>([
        [VDS_COSE_RECEIPT_PROOFS_TAG, new Map<number, unknown>([[-2, proofBstr]])],
      ]),
      null,
      sig,
    ]);
  };

  const checkpoints = [
    await buildCheckpoint(0n, 3n),
    await buildCheckpoint(3n, 7n),
    await buildCheckpoint(7n, 10n),
    await buildCheckpoint(10n, 15n),
  ];

  // Old-era receipt: leaf mmrIndex 1 proven under the size-3 seal — its
  // peak (node 2) is an INTERIOR node of every later state.
  const leafMmrIndex = 1n;
  const leafHash = nodes[1]!;
  const buriedPeak = nodes[2]!;
  const receiptSig = await sign(keyPair, protectedBstr, buriedPeak);
  const receiptCbor = encodeCborDeterministic([
    protectedBstr,
    new Map<number, unknown>([
      [
        VDS_COSE_RECEIPT_PROOFS_TAG,
        new Map<number, unknown>([
          [-1, [new Map<number, unknown>([[1, leafMmrIndex], [2, [nodes[0]!]]])]],
        ]),
      ],
    ]),
    null,
    receiptSig,
  ]);

  return {
    checkpoints,
    receiptCbor,
    leafHash,
    leafMmrIndex,
    buriedPeak,
    finalAccumulator: peaksAt(14n),
    publicKeyXy,
    keyPair,
  };
}
