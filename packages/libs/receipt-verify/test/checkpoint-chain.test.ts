/**
 * FOR-368 Phase 3: retained checkpoint chain fold (plan-2607-29). Synthetic
 * v3-shaped checkpoints over an in-memory MMR: each link is a signed
 * draft-bryce Receipt of Consistency whose detached payload is its
 * tree-size-2 accumulator (ADR-0046), chained boundary-to-boundary
 * (ADR-0056).
 */
import { describe, expect, it, beforeAll } from "vitest";
import {
  encodeCborDeterministic,
  encodeSigStructure,
  verifyCoseSign1WithParsedKey,
} from "@forestrie/encoding";
import {
  consistentRoots,
  indexConsistencyProof,
  indexHeight,
  peakMMRIndexes,
} from "@forestrie/merklelog";
import {
  accumulatorPayload,
  checkpointConsistencyProof,
  verifyCheckpointChain,
} from "../src/checkpoint-chain.js";
import { SubtleHasher } from "../src/subtle-hasher.js";

let keyPair: CryptoKeyPair;
let nodes: Uint8Array[];
const getHash = (i: bigint) => nodes[Number(i)]!;

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

async function addLeaf(all: Uint8Array[], leaf: Uint8Array): Promise<void> {
  all.push(leaf);
  let g = 0;
  while (indexHeight(BigInt(all.length)) > g) {
    const right = all[all.length - 1]!;
    const left = all[all.length - (2 ** (g + 1) - 1) - 1]!;
    const pos = new Uint8Array(8);
    new DataView(pos.buffer).setBigUint64(0, BigInt(all.length + 1));
    all.push(await sha256(pos, left, right));
    g += 1;
  }
}

function peaksAt(lastIndex: bigint): Uint8Array[] {
  return peakMMRIndexes(lastIndex).map((i) => nodes[Number(i)]!);
}

/** Build a signed v3-shaped checkpoint for sizeFrom -> sizeTo. */
async function buildCheckpoint(
  sizeFrom: bigint,
  sizeTo: bigint,
  mutate?: (proof: {
    treeSize1: bigint;
    paths: Uint8Array[][];
    rightPeaks: Uint8Array[];
  }) => void,
): Promise<Uint8Array> {
  const hasher = new SubtleHasher();
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
  const shaped = { treeSize1: sizeFrom, paths, rightPeaks };
  mutate?.(shaped);
  const proofBstr = encodeCborDeterministic([
    shaped.treeSize1,
    sizeTo,
    shaped.paths,
    shaped.rightPeaks,
  ]);
  const protectedBstr = encodeCborDeterministic(new Map([[1, -7]]));
  const payload = accumulatorPayload(accumulatorTo);
  const sigStructure = encodeSigStructure(
    protectedBstr,
    new Uint8Array(0),
    payload,
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      sigStructure.buffer.slice(
        sigStructure.byteOffset,
        sigStructure.byteOffset + sigStructure.byteLength,
      ) as ArrayBuffer,
    ),
  );
  const unprotected = new Map<number, unknown>([
    [396, new Map<number, unknown>([[-2, proofBstr]])],
  ]);
  return encodeCborDeterministic([protectedBstr, unprotected, null, sig]);
}

const verifySig = (bytes: Uint8Array, detachedPayload: Uint8Array) =>
  verifyCoseSign1WithParsedKey(bytes, keyPair.publicKey, { detachedPayload });

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  nodes = [];
  for (let i = 0; i < 8; i++) {
    const seed = new Uint8Array(8);
    new DataView(seed.buffer).setBigUint64(0, BigInt(i));
    await addLeaf(nodes, await sha256(seed));
  }
  // 8 leaves -> 15 nodes; complete sizes used: 3, 7, 10, 15.
  expect(nodes.length).toBe(15);
});

describe("verifyCheckpointChain (FOR-368 Phase 3)", () => {
  it("folds a whole-log boundary chain to the final authenticated accumulator", async () => {
    const chain = [
      await buildCheckpoint(0n, 3n),
      await buildCheckpoint(3n, 7n),
      await buildCheckpoint(7n, 10n),
      await buildCheckpoint(10n, 15n),
    ];
    const result = await verifyCheckpointChain({
      checkpoints: chain,
      verifySignature: verifySig,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.links.length).toBe(4);
    expect(result.links.every((l) => l.signatureOk)).toBe(true);
    expect(
      result.accumulator.map((p) => Buffer.from(p).toString("hex")),
    ).toEqual(peaksAt(14n).map((p) => Buffer.from(p).toString("hex")));
  });

  it("verifies a suffix chain from a trusted base accumulator", async () => {
    const chain = [
      await buildCheckpoint(3n, 7n),
      await buildCheckpoint(7n, 10n),
    ];
    const result = await verifyCheckpointChain({
      checkpoints: chain,
      verifySignature: verifySig,
      accumulatorFrom: peaksAt(2n),
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a suffix chain without a trusted base", async () => {
    const result = await verifyCheckpointChain({
      checkpoints: [await buildCheckpoint(3n, 7n)],
      verifySignature: verifySig,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("legacy_chain_break");
  });

  it("detects the pre-FOR-410 drift as legacy_chain_break", async () => {
    // Second link chains from an intermediate (7) instead of the previous
    // sealed size (3): the drifted-.sth shape.
    const chain = [
      await buildCheckpoint(0n, 3n),
      await buildCheckpoint(7n, 10n),
    ];
    const result = await verifyCheckpointChain({
      checkpoints: chain,
      verifySignature: verifySig,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("legacy_chain_break");
    expect(result.at).toBe(1);
    expect(result.detail).toContain("pre-FOR-410");
  });

  it("a tampered signature fails at its link", async () => {
    const good = await buildCheckpoint(0n, 3n);
    const bad = good.slice();
    bad[bad.length - 1]! ^= 0xff;
    const result = await verifyCheckpointChain({
      checkpoints: [bad],
      verifySignature: verifySig,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("signature");
    expect(result.at).toBe(0);
  });

  it("forged right-peaks cannot carry the signature", async () => {
    // The signature covers the TRUE accumulator; swapping a right-peak
    // changes the computed payload, so the signature check fails.
    // 3 -> 10 has a genuine right-peak (node 9) beyond the proven root.
    const forged = await buildCheckpoint(3n, 10n, (p) => {
      expect(p.rightPeaks.length).toBeGreaterThan(0);
      p.rightPeaks = p.rightPeaks.map((x) => {
        const c = x.slice();
        c[0]! ^= 0xff;
        return c;
      });
    });
    const result = await verifyCheckpointChain({
      checkpoints: [forged],
      verifySignature: verifySig,
      accumulatorFrom: peaksAt(2n),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["signature", "proof_malformed"]).toContain(result.reason);
  });

  it("decodes the embedded proof shape", async () => {
    const cp = await buildCheckpoint(3n, 7n);
    const proof = checkpointConsistencyProof(cp);
    expect(proof.treeSize1).toBe(3n);
    expect(proof.treeSize2).toBe(7n);
    expect(proof.paths.length).toBe(peakMMRIndexes(2n).length);
  });
});
