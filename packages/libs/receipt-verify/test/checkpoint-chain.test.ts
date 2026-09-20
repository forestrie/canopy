/**
 * FOR-368 Phase 3: retained checkpoint chain fold (plan-2607-29). Synthetic
 * v3-shaped checkpoints over an in-memory MMR: each link is a signed
 * draft-bryce Receipt of Consistency whose detached payload is its
 * tree-size-2 accumulator (ADR-0046), chained boundary-to-boundary
 * (ADR-0056).
 */
import { describe, expect, it, beforeAll } from "vitest";
import {
  COSE_LABEL_TREE_SIZE_2,
  COSE_LABEL_VDS,
  VDS_MMR_CONSISTENCY,
  decodeCborDeterministic,
  encodeCborDeterministic,
  encodeSigStructure,
  verifyCoseSign1WithParsedKey,
} from "@forestrie/encoding";
import {
  consistentRootsForSizes,
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

function peak(b: number): Uint8Array {
  return new Uint8Array(32).fill(b);
}

async function signOverProtected(
  protectedBstr: Uint8Array,
  payload: Uint8Array,
): Promise<Uint8Array> {
  const sigStructure = encodeSigStructure(
    protectedBstr,
    new Uint8Array(0),
    payload,
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

/** The real (structurally valid) declared proof from `sizeFrom` -> `sizeTo`
 * over the fixture MMR. */
async function realProof(
  sizeFrom: bigint,
  sizeTo: bigint,
): Promise<{
  treeSize1: bigint;
  paths: Uint8Array[][];
  rightPeaks: Uint8Array[];
}> {
  const accumulatorTo = peaksAt(sizeTo - 1n);
  if (sizeFrom === 0n) {
    return { treeSize1: 0n, paths: [], rightPeaks: accumulatorTo };
  }
  const hasher = new SubtleHasher();
  const cp = indexConsistencyProof(getHash, sizeFrom - 1n, sizeTo - 1n);
  const { roots } = await consistentRootsForSizes(
    hasher,
    sizeFrom,
    sizeTo,
    peaksAt(sizeFrom - 1n),
    cp.paths,
  );
  return {
    treeSize1: sizeFrom,
    paths: cp.paths,
    rightPeaks: accumulatorTo.slice(roots.length),
  };
}

/** The canonical sealer protected header `{1: alg, 395: vds, -65933:
 * tree-size-2}` (ADR-0066 D1 as amended) — tree-size-1 is never a member. */
function checkpointProtectedHeader(sizeTo: bigint): Uint8Array {
  return encodeCborDeterministic(
    new Map<number, unknown>([
      [1, -7],
      [COSE_LABEL_VDS, VDS_MMR_CONSISTENCY],
      [COSE_LABEL_TREE_SIZE_2, sizeTo],
    ]),
  );
}

/** Build a signed v3-shaped checkpoint for sizeFrom -> sizeTo: only
 * tree-size-2 is SIGNED (ADR-0066 D1 as amended); the declared (unprotected)
 * consistency-proof tree-size-1/tree-size-2 are sizeFrom/sizeTo. */
async function buildCheckpoint(
  sizeFrom: bigint,
  sizeTo: bigint,
  mutate?: (proof: {
    treeSize1: bigint;
    paths: Uint8Array[][];
    rightPeaks: Uint8Array[];
  }) => void,
): Promise<Uint8Array> {
  const accumulatorTo = peaksAt(sizeTo - 1n);
  const shaped = await realProof(sizeFrom, sizeTo);
  mutate?.(shaped);
  const proofBstr = encodeCborDeterministic([
    shaped.treeSize1,
    sizeTo,
    shaped.paths,
    shaped.rightPeaks,
  ]);
  const protectedBstr = checkpointProtectedHeader(sizeTo);
  const payload = accumulatorPayload(accumulatorTo);
  const sig = await signOverProtected(protectedBstr, payload);
  const unprotected = new Map<number, unknown>([
    [396, new Map<number, unknown>([[-2, proofBstr]])],
  ]);
  return encodeCborDeterministic([protectedBstr, unprotected, null, sig]);
}

/**
 * Build a checkpoint with full, independent control over the SIGNED
 * tree-size-2 and the DECLARED (unprotected) consistency proof — for the
 * ADR-0066 signed-vs-declared and shape-negative fixtures, where the two
 * must diverge on purpose. The signature covers whatever `signatureBytes`
 * is supplied (arbitrary bytes are fine for a fixture whose fold is
 * expected to fail before any signature check is reached).
 */
function buildShapedCheckpoint(opts: {
  signedTo?: bigint;
  omitSignedSizes?: boolean;
  declaredFrom: bigint;
  declaredTo: bigint;
  paths: Uint8Array[][];
  rightPeaks: Uint8Array[];
  signatureBytes?: Uint8Array;
}): Uint8Array {
  const protectedMap = new Map<number, unknown>([[1, -7]]);
  if (!opts.omitSignedSizes) {
    protectedMap.set(COSE_LABEL_VDS, VDS_MMR_CONSISTENCY);
    protectedMap.set(COSE_LABEL_TREE_SIZE_2, opts.signedTo ?? opts.declaredTo);
  }
  const protectedBstr = encodeCborDeterministic(protectedMap);
  const proofBstr = encodeCborDeterministic([
    opts.declaredFrom,
    opts.declaredTo,
    opts.paths,
    opts.rightPeaks,
  ]);
  const unprotected = new Map<number, unknown>([
    [396, new Map<number, unknown>([[-2, proofBstr]])],
  ]);
  // The signature is only ever checked once a fold SUCCEEDS; every fixture
  // built with mismatched signed/declared sizes or a shape violation fails
  // before that point, so a throwaway signature is sufficient here.
  const sig = opts.signatureBytes ?? new Uint8Array(64);
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
    // Every link's signed tree-size-2 (ADR-0066 D1 as amended) equals its
    // declared tree-size-2; tree-size-1 is never signed.
    const expectedSizeTo = [3n, 7n, 10n, 15n];
    result.links.forEach((l, i) => {
      expect(l.signedTreeSize2).toBe(expectedSizeTo[i]);
      expect(l.signedTreeSize2).toBe(l.treeSize2);
    });
  });

  it("verifies a suffix chain from a trusted base accumulator", async () => {
    const chain = [
      await buildCheckpoint(3n, 7n),
      await buildCheckpoint(7n, 10n),
    ];
    const result = await verifyCheckpointChain({
      checkpoints: chain,
      verifySignature: verifySig,
      trustedBase: { size: 3n, accumulator: peaksAt(2n) },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a suffix chain whose trustedBase.size disagrees with the first link's declared base", async () => {
    const result = await verifyCheckpointChain({
      checkpoints: [await buildCheckpoint(3n, 7n)],
      verifySignature: verifySig,
      trustedBase: { size: 2n, accumulator: peaksAt(1n) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("size_mismatch");
    expect(result.at).toBe(0);
    expect(result.detail).toContain("3");
    expect(result.detail).toContain("2");
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
      trustedBase: { size: 3n, accumulator: peaksAt(2n) },
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

describe("checkpointConsistencyProof — malformed size rejection (FOR-414)", () => {
  /** Wrap an arbitrary `[ts1, ts2, paths, rightPeaks]` in a checkpoint COSE
   * shape with a throwaway signature — decode runs before any signature
   * check, so the bytes need not be genuinely signed. */
  function checkpointWithProof(proofArray: unknown): Uint8Array {
    const proofBstr = encodeCborDeterministic(proofArray);
    const protectedBstr = encodeCborDeterministic(new Map([[1, -7]]));
    const unprotected = new Map<number, unknown>([
      [396, new Map<number, unknown>([[-2, proofBstr]])],
    ]);
    return encodeCborDeterministic([
      protectedBstr,
      unprotected,
      null,
      new Uint8Array(64),
    ]);
  }

  it("rejects tree-size-2 = 0 in bounded time (the reported hang trigger)", () => {
    // Pre-fix: treeSize2 - 1 = -1 → peakMMRIndexes(-1n) spun forever.
    expect(() =>
      checkpointConsistencyProof(checkpointWithProof([0, 0, [], []])),
    ).toThrow(/grow the tree/);
  });

  it("rejects a negative size", () => {
    expect(() =>
      checkpointConsistencyProof(checkpointWithProof([-1, 5, [], []])),
    ).toThrow(/unsigned integer/);
    expect(() =>
      checkpointConsistencyProof(checkpointWithProof([3, -7, [], []])),
    ).toThrow(/unsigned integer/);
  });

  it("rejects a non-growing proof (tree-size-2 <= tree-size-1)", () => {
    expect(() =>
      checkpointConsistencyProof(checkpointWithProof([7, 3, [], []])),
    ).toThrow(/grow the tree/);
    expect(() =>
      checkpointConsistencyProof(checkpointWithProof([5, 5, [], []])),
    ).toThrow(/grow the tree/);
  });

  it("rejects a right-peak that is not 32 bytes", () => {
    expect(() =>
      checkpointConsistencyProof(
        checkpointWithProof([0, 3, [], [new Uint8Array(31).fill(1)]]),
      ),
    ).toThrow(/32-byte/);
  });

  it("verifyCheckpointChain reports proof_malformed (not a hang) for a bad size", async () => {
    const result = await verifyCheckpointChain({
      checkpoints: [checkpointWithProof([0, 0, [], [peak(1)]])],
      verifySignature: verifySig,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("proof_malformed");
    expect(result.at).toBe(0);
  });
});

describe("signed vs declared tree-size-2 (ADR-0066 D1 as amended, FOR-568)", () => {
  it("rejects a checkpoint re-declared at a different size than it was signed for (size substitution)", async () => {
    // Signed for tree-size-2 = 3; the unprotected proof instead declares
    // tree-size-2 = 7 with a structurally plausible (real) right-peak count
    // for that size — the keyless "first checkpoint" substitution ADR-0066
    // describes: a party without the signing key can rewrite the
    // unprotected proof, but not the protected header the signature covers.
    const declared = await realProof(0n, 7n);
    const cp = buildShapedCheckpoint({
      signedTo: 3n,
      declaredFrom: declared.treeSize1,
      declaredTo: 7n,
      paths: declared.paths,
      rightPeaks: declared.rightPeaks,
    });
    const result = await verifyCheckpointChain({
      checkpoints: [cp],
      verifySignature: verifySig,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("size_mismatch");
    expect(result.at).toBe(0);
    expect(result.detail).toContain("3");
    expect(result.detail).toContain("7");
  });

  it("rejects a checkpoint whose signed tree-size-2 differs from an otherwise-real declared extension", async () => {
    // Signed for tree-size-2 = 8; the unprotected proof declares the
    // genuine (7 -> 10) extension instead.
    const declared = await realProof(7n, 10n);
    const cp = buildShapedCheckpoint({
      signedTo: 8n,
      declaredFrom: declared.treeSize1,
      declaredTo: 10n,
      paths: declared.paths,
      rightPeaks: declared.rightPeaks,
    });
    const result = await verifyCheckpointChain({
      checkpoints: [cp],
      verifySignature: verifySig,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("size_mismatch");
    expect(result.detail).toContain("8");
    expect(result.detail).toContain("10");
  });

  it("rejects a checkpoint with no signed tree-size-2 as proof_malformed", async () => {
    const declared = await realProof(3n, 7n);
    const cp = buildShapedCheckpoint({
      omitSignedSizes: true,
      declaredFrom: declared.treeSize1,
      declaredTo: 7n,
      paths: declared.paths,
      rightPeaks: declared.rightPeaks,
    });
    const result = await verifyCheckpointChain({
      checkpoints: [cp],
      verifySignature: verifySig,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("proof_malformed");
    expect(result.detail).toContain("-65933");
  });

  it("rejects a keyless size-freeze: signed for size 1, declared at 2^64-1", async () => {
    // The extreme form of the size-substitution case above (this is the
    // "keyless first checkpoint" case ADR-0066's Context describes): a
    // party without the signing key restates the unprotected proof at the
    // largest representable size while the protected header — and hence
    // the signature — still names size 1. Caught by the signed-vs-declared
    // tree-size-2 comparison alone; no fold is attempted.
    const cp = buildShapedCheckpoint({
      signedTo: 1n,
      declaredFrom: 0n,
      declaredTo: 0xffffffffffffffffn,
      paths: [],
      rightPeaks: [peak(1)],
    });
    const result = await verifyCheckpointChain({
      checkpoints: [cp],
      verifySignature: verifySig,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("size_mismatch");
    expect(result.detail).toContain("1");
    expect(result.detail).toContain("18446744073709551615");
  });
});

describe("tree-size-1 is unsigned prover context, not part of the signature (ADR-0066 D2 withdrawn)", () => {
  it("accepts a 3-link chain whose middle link's base is re-based (no signed value names it)", async () => {
    // Every link signs only tree-size-2 (ADR-0066 D1 as amended). The
    // middle checkpoint's declared tree-size-1 (3, contiguity's
    // requirement) is not itself signed by anything — the publisher could
    // have re-based this relayed step and the signature would be
    // unaffected, which is exactly the point of the second half of this
    // test group below.
    const chain = [
      await buildCheckpoint(0n, 3n),
      await buildCheckpoint(3n, 7n),
      await buildCheckpoint(7n, 10n),
    ];
    const result = await verifyCheckpointChain({
      checkpoints: chain,
      verifySignature: verifySig,
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a checkpoint carrying a proof re-based from a different origin under the same size-7 signature", async () => {
    // The real relayed step is 3 -> 7. Take that checkpoint's protected
    // header and signature UNCHANGED (both are a function only of
    // tree-size-2 = 7 and the size-7 accumulator, never of tree-size-1) and
    // attach a DIFFERENT declared consistency proof rooted at 0 instead of
    // 3. The result still verifies as the first link of a chain anchored at
    // trustedBase.size 0 — a signed tree-size-1 would have rejected this
    // re-based publish, which is exactly why D2 is withdrawn.
    const trueLink = await buildCheckpoint(3n, 7n);
    const [protectedBstr, , , sig] = decodeCborDeterministic(trueLink) as [
      Uint8Array,
      unknown,
      unknown,
      Uint8Array,
    ];
    const rebased = await realProof(0n, 7n);
    const proofBstr = encodeCborDeterministic([
      rebased.treeSize1,
      7n,
      rebased.paths,
      rebased.rightPeaks,
    ]);
    const unprotected = new Map<number, unknown>([
      [396, new Map<number, unknown>([[-2, proofBstr]])],
    ]);
    const rebasedCheckpoint = encodeCborDeterministic([
      protectedBstr,
      unprotected,
      null,
      sig,
    ]);
    const result = await verifyCheckpointChain({
      checkpoints: [rebasedCheckpoint],
      verifySignature: verifySig,
      trustedBase: { size: 0n, accumulator: [] },
    });
    expect(result.ok).toBe(true);
  });
});

describe("consistency-proof shape violations fold to proof_malformed (ADR-0066 D5)", () => {
  it("rejects an incomplete target size (0 -> 6)", async () => {
    const cp = await buildCheckpoint(0n, 6n);
    const result = await verifyCheckpointChain({
      checkpoints: [cp],
      verifySignature: verifySig,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("proof_malformed");
    expect(result.detail).toMatch(/not a complete MMR size/);
  });

  it("rejects a path lengthened by one hop (3 -> 7)", async () => {
    const cp = await buildCheckpoint(3n, 7n, (p) => {
      p.paths[0] = [...p.paths[0]!, peak(9)];
    });
    const result = await verifyCheckpointChain({
      checkpoints: [cp],
      verifySignature: verifySig,
      trustedBase: { size: 3n, accumulator: peaksAt(2n) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("proof_malformed");
    expect(result.detail).toMatch(/expected length/);
  });

  it("rejects an empty path where the sizes imply one hop (1 -> 3)", async () => {
    const cp = await buildCheckpoint(1n, 3n, (p) => {
      p.paths[0] = [];
    });
    const result = await verifyCheckpointChain({
      checkpoints: [cp],
      verifySignature: verifySig,
      trustedBase: { size: 1n, accumulator: peaksAt(0n) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("proof_malformed");
    expect(result.detail).toMatch(/expected length/);
  });

  it("rejects a right-peak count off by one (3 -> 7)", async () => {
    const cp = await buildCheckpoint(3n, 7n, (p) => {
      p.rightPeaks = [peak(9)];
    });
    const result = await verifyCheckpointChain({
      checkpoints: [cp],
      verifySignature: verifySig,
      trustedBase: { size: 3n, accumulator: peaksAt(2n) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("proof_malformed");
    expect(result.detail).toMatch(/right-peaks/);
  });
});
