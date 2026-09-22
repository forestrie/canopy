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
  CheckpointHighSSignatureError,
  CheckpointProtectedHeaderAlgError,
  checkpointConsistencyProof,
  verifyCheckpointChain,
} from "../src/checkpoint-chain.js";
import { SubtleHasher } from "../src/subtle-hasher.js";
import { toHighS, toLowS } from "./helpers/to-low-s.js";

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
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      sigStructure.buffer.slice(
        sigStructure.byteOffset,
        sigStructure.byteOffset + sigStructure.byteLength,
      ) as ArrayBuffer,
    ),
  );
  return toLowS(raw);
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
    // Both sizes are complete MMR sizes, so the base survives the shape
    // checks and it is the declared-vs-trusted comparison that rejects it.
    const result = await verifyCheckpointChain({
      checkpoints: [await buildCheckpoint(3n, 7n)],
      verifySignature: verifySig,
      trustedBase: { size: 4n, accumulator: peaksAt(3n) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("size_mismatch");
    expect(result.at).toBe(0);
    expect(result.detail).toContain("3");
    expect(result.detail).toContain("4");
  });

  it("refuses a suffix chain without a trusted base", async () => {
    const result = await verifyCheckpointChain({
      checkpoints: [await buildCheckpoint(3n, 7n)],
      verifySignature: verifySig,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("size_mismatch");
    expect(result.at).toBe(0);
    expect(result.detail).toContain("3");
    expect(result.detail).toContain("0");
  });

  it("reports a link that does not continue the previous one as size_mismatch", async () => {
    // Second link chains from an intermediate (7) instead of the previous
    // sealed size (3). The declared base is unsigned, so this reason names
    // the two sizes and nothing else: no pre-FOR-410 state is supported
    // (ADR-0066 D6), so there is no fallback for it to select.
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
    expect(result.reason).toBe("size_mismatch");
    expect(result.at).toBe(1);
    expect(result.detail).toContain("7");
    expect(result.detail).toContain("3");
    expect(result.detail).toContain("not continuous");
  });

  it("an altered signature fails at its link, and links holds only the verified prefix", async () => {
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
    // The computed accumulator of a link whose signature did not verify is
    // attested by nothing, so it is not handed back.
    expect(result.links.length).toBe(0);

    // The same, one link in: the verified first link is kept, the failing
    // second is not.
    const secondBad = (await buildCheckpoint(3n, 7n)).slice();
    secondBad[secondBad.length - 1]! ^= 0xff;
    const twoLinks = await verifyCheckpointChain({
      checkpoints: [await buildCheckpoint(0n, 3n), secondBad],
      verifySignature: verifySig,
    });
    expect(twoLinks.ok).toBe(false);
    if (twoLinks.ok) return;
    expect(twoLinks.reason).toBe("signature");
    expect(twoLinks.at).toBe(1);
    expect(twoLinks.links.length).toBe(1);
    expect(twoLinks.links.every((l) => l.signatureOk)).toBe(true);
    expect(twoLinks.links[0]!.treeSize2).toBe(3n);
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

  it("rejects a path node that is not 32 bytes, naming the path and element", () => {
    // The same rule a right-peak gets. A path node is an MMR node and ends
    // up in the same places: the fold hashes it, and the peaks that come out
    // are concatenated without delimiters into the payload the signature is
    // checked against, so a node of any other length makes that payload
    // ambiguous.
    expect(() =>
      checkpointConsistencyProof(
        checkpointWithProof([
          3,
          7,
          [[peak(1), new Uint8Array(31).fill(2)]],
          [peak(3)],
        ]),
      ),
    ).toThrow(/consistency path 0 element 1: expected a 32-byte string/);
  });

  it("rejects an oversized path node at decode, before it reaches the hasher", () => {
    // 64 KiB per node from an unauthenticated `.sth`: rejected on the length
    // rule, so nothing allocates or hashes it while the signature is still
    // unchecked.
    expect(() =>
      checkpointConsistencyProof(
        checkpointWithProof([
          3,
          7,
          [[new Uint8Array(64 * 1024).fill(9)]],
          [peak(3)],
        ]),
      ),
    ).toThrow(/consistency path 0 element 0: expected a 32-byte string/);
  });

  it("rejects a path that is not an array, naming the path", () => {
    expect(() =>
      checkpointConsistencyProof(checkpointWithProof([3, 7, [peak(1)], []])),
    ).toThrow(/consistency path 0: expected an array of 32-byte strings/);
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

describe("the trusted base must describe a state an MMR can be in (ADR-0066 D5.1)", () => {
  it("rejects a trustedBase.size that is not a complete MMR size", async () => {
    // 5 is not a size any MMR has (4 and 7 are the complete sizes either
    // side), and `peaksBitmap` rounds it DOWN to MMR(4): the size-4
    // accumulator has the peak count 5 appears to require and the genuine
    // 4 -> 7 material has the path shape 5 -> 7 appears to require. Left
    // unchecked, the chain folds the 4 -> 7 shape and every link reports a
    // base of 5 — a node count no MMR can have — while its sealed size stays
    // genuine.
    const cp = await buildCheckpoint(4n, 7n, (p) => {
      p.treeSize1 = 5n; // unsigned prover context
    });
    const result = await verifyCheckpointChain({
      checkpoints: [cp],
      verifySignature: verifySig,
      trustedBase: { size: 5n, accumulator: peaksAt(3n) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("proof_malformed");
    expect(result.at).toBe(0);
    expect(result.detail).toMatch(/not a complete MMR size/);
    expect(result.links.length).toBe(0);
  });

  it("rejects a trustedBase.accumulator that does not hold that size's peaks", async () => {
    // MMR(10) has two peaks, MMR(3) one. The fold compares only against the
    // count the ROUNDED-DOWN size implies, so the base's own peak count is
    // checked here, before any fold runs.
    const result = await verifyCheckpointChain({
      checkpoints: [await buildCheckpoint(3n, 7n)],
      verifySignature: verifySig,
      trustedBase: { size: 3n, accumulator: peaksAt(9n) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("proof_malformed");
    expect(result.detail).toMatch(/2 peaks; size 3 has 1/);
  });

  it("accepts size 0 with an empty accumulator (the whole-log base)", async () => {
    const result = await verifyCheckpointChain({
      checkpoints: [await buildCheckpoint(0n, 3n)],
      verifySignature: verifySig,
      trustedBase: { size: 0n, accumulator: [] },
    });
    expect(result.ok).toBe(true);
  });
});

describe("the reason a declared tree-size-1 produces cannot outrank the signature", () => {
  it("reports size_mismatch and still hands back the verified first link", async () => {
    // `tree-size-1` is unsigned: a relaying party can set it without the
    // key. Here link 1's signature does NOT verify AND its declared base is
    // edited to a value that does not continue link 0. Whichever of the two
    // is reported, the reason is selectable without the key — which is why
    // no reason may mean more than the size disagreement it names (ADR-0066
    // D6: no pre-FOR-410 state is supported, so there is nothing to fall
    // back to). What the caller gets instead is `links`: the prefix whose
    // signatures verified, and never an unverified link.
    const altered = (
      await buildCheckpoint(3n, 7n, (p) => {
        p.treeSize1 = 4n;
      })
    ).slice();
    altered[altered.length - 1]! ^= 0xff;
    const result = await verifyCheckpointChain({
      checkpoints: [await buildCheckpoint(0n, 3n), altered],
      verifySignature: verifySig,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("size_mismatch");
    expect(result.at).toBe(1);
    expect(result.detail).toContain("4");
    expect(result.detail).toContain("3");
    expect(result.detail).toContain("not continuous");
    expect(result.links.length).toBe(1);
    expect(result.links.every((l) => l.signatureOk)).toBe(true);
    expect(result.links[0]!.treeSize2).toBe(3n);
  });
});

/** Re-sign nothing — swap `s` for `n - s` on an already-valid checkpoint's
 * signature, its malleable (high-s) twin over the exact same message. */
function withHighSSignature(checkpointBytes: Uint8Array): Uint8Array {
  const arr = decodeCborDeterministic(checkpointBytes) as [
    Uint8Array,
    unknown,
    unknown,
    Uint8Array,
  ];
  const [protectedBstr, unprotected, payload, sig] = arr;
  expect(sig.length).toBe(64);
  return encodeCborDeterministic([
    protectedBstr,
    unprotected,
    payload,
    toHighS(sig),
  ]);
}

describe("high-s ES256 checkpoint signatures are rejected (FOR-568 rollout item 4)", () => {
  // go-merklelog now rejects s > n/2 for ES256 checkpoint signatures because
  // the univocity contract's P-256 verifier rejects them; a canopy verifier
  // that accepted the high-s twin could pass a receipt the chain refuses.
  // Scoped to the checkpoint receipt path only (checkpointConsistencyProof):
  // the WebAuthn (-65800) and session-key-endorsement (-65801) paths are
  // untouched by this change.

  it("checkpointConsistencyProof throws CheckpointHighSSignatureError", async () => {
    const valid = await buildCheckpoint(0n, 3n);
    // Confidence check: the fixture signer normalizes to low-s (toLowS in
    // signOverProtected), so the unmutated checkpoint must not itself throw.
    expect(() => checkpointConsistencyProof(valid)).not.toThrow();

    const highS = withHighSSignature(valid);
    expect(() => checkpointConsistencyProof(highS)).toThrow(
      CheckpointHighSSignatureError,
    );
  });

  it("verifyCheckpointChain reports signature_malleable, before any WebCrypto verify", async () => {
    const valid = await buildCheckpoint(0n, 3n);
    const highS = withHighSSignature(valid);

    // A verifySignature spy proves the high-s signature is rejected before
    // this callback — which wraps the exact WebCrypto verify path — is ever
    // invoked, not merely that the end result happens to be `ok: false`.
    let verifySignatureCalled = false;
    const result = await verifyCheckpointChain({
      checkpoints: [highS],
      verifySignature: async (bytes, detachedPayload) => {
        verifySignatureCalled = true;
        return verifySig(bytes, detachedPayload);
      },
      trustedBase: { size: 0n, accumulator: [] },
    });

    expect(verifySignatureCalled).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("signature_malleable");
    expect(result.at).toBe(0);
    expect(result.detail).toMatch(/low-s/);
    expect(result.links.length).toBe(0);
  });

  it("the same checkpoint with its original low-s signature verifies", async () => {
    // Round-trip confidence: withHighSSignature's mutation, not some other
    // defect in the fixture, is what flips the outcome.
    const valid = await buildCheckpoint(0n, 3n);
    const result = await verifyCheckpointChain({
      checkpoints: [valid],
      verifySignature: verifySig,
      trustedBase: { size: 0n, accumulator: [] },
    });
    expect(result.ok).toBe(true);
  });
});

describe("a protected header with no integer alg is rejected (review S-1)", () => {
  // The univocity contract's reader rejects both of these headers — its
  // structural walk finds the size, and the `alg` requirement in the same
  // call raises `ClaimNotFound(1)` / `UnexpectedMajorType`. Off-chain the
  // lenient read answered `null`, which switched the high-s rejection off
  // (it is conditioned on the algorithm being ES256) while the signed size
  // was still read out of the same header. The three headers below are the
  // ones the finding's probe fed to both sides.
  const fromHex = (h: string) =>
    new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));

  /** `{1: -7, 395: 3, -65933: 8}` — a canonical sealer header. */
  const CANONICAL = fromHex("a3012619018b033a0001018c08");
  /** The same header with label 1 absent: `{395: 3, -65933: 8}`. */
  const NO_ALG = fromHex("a219018b033a0001018c08");
  /** The same header with a byte string under label 1: `{1: h'26', …}`. */
  const BSTR_ALG = fromHex("a301412619018b033a0001018c08");

  /** P-256 group order; `s = n - 1` is the malleable high-s twin. */
  const P256_N = BigInt(
    "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
  );

  function be32(v: bigint): Uint8Array {
    const out = new Uint8Array(32);
    for (let i = 31; i >= 0; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }

  const HIGH_S = new Uint8Array(64);
  HIGH_S.set(be32(1n), 0);
  HIGH_S.set(be32(P256_N - 1n), 32);

  const node = (b: number) => new Uint8Array(32).fill(b);
  /** A 7 -> 8 consistency proof: one origin peak path, no right peaks. */
  const PROOF = encodeCborDeterministic([
    7n,
    8n,
    [[node(1), node(2), node(3)]],
    [],
  ]);

  /** A checkpoint carrying that proof, the high-s signature, and `header`. */
  function checkpointWithHeader(header: Uint8Array): Uint8Array {
    return encodeCborDeterministic([
      header,
      new Map<number, unknown>([
        [396, new Map<number, unknown>([[-2, PROOF]])],
      ]),
      null,
      HIGH_S,
    ]);
  }

  it("rejects a header with no label 1", () => {
    expect(() =>
      checkpointConsistencyProof(checkpointWithHeader(NO_ALG)),
    ).toThrow(CheckpointProtectedHeaderAlgError);
  });

  it("rejects a byte string under label 1", () => {
    expect(() =>
      checkpointConsistencyProof(checkpointWithHeader(BSTR_ALG)),
    ).toThrow(CheckpointProtectedHeaderAlgError);
  });

  it("the canonical header reaches the high-s rejection", () => {
    // The contrast the finding turns on: with the algorithm stated, the same
    // signature is rejected as malleable. Both rejections must happen, and
    // neither header may yield a signed size to fold from.
    expect(() =>
      checkpointConsistencyProof(checkpointWithHeader(CANONICAL)),
    ).toThrow(CheckpointHighSSignatureError);
  });

  it("verifyCheckpointChain reports proof_malformed for both headers", async () => {
    for (const header of [NO_ALG, BSTR_ALG]) {
      const result = await verifyCheckpointChain({
        checkpoints: [checkpointWithHeader(header)],
        verifySignature: verifySig,
        trustedBase: { size: 7n, accumulator: peaksAt(6n) },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("proof_malformed");
      expect(result.at).toBe(0);
      expect(result.detail).toMatch(/no integer alg/);
      expect(result.links.length).toBe(0);
    }
  });
});

describe("every trusted base peak is a 32-byte node value (review I2, canopy C6)", () => {
  // The peak COUNT was checked, the byte lengths were not. On the empty-path
  // branch an origin peak is copied into the result verbatim, so a peak of
  // any length reaches `accumulatorPayload` and changes the detached payload
  // the signature is checked over, with only that signature rejecting it.
  it("rejects a 31-byte trusted base peak", async () => {
    const result = await verifyCheckpointChain({
      checkpoints: [await buildCheckpoint(3n, 7n)],
      verifySignature: verifySig,
      trustedBase: { size: 3n, accumulator: [new Uint8Array(31).fill(7)] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("proof_malformed");
    expect(result.at).toBe(0);
    expect(result.detail).toMatch(/peak 0 is not a 32-byte node value/);
    expect(result.detail).toMatch(/31 bytes/);
    expect(result.links.length).toBe(0);
  });

  it("rejects a 33-byte trusted base peak", async () => {
    const result = await verifyCheckpointChain({
      checkpoints: [await buildCheckpoint(3n, 7n)],
      verifySignature: verifySig,
      trustedBase: { size: 3n, accumulator: [new Uint8Array(33).fill(7)] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("proof_malformed");
    expect(result.detail).toMatch(/33 bytes/);
  });

  it("rejects an empty and an over-long trusted base peak", async () => {
    for (const length of [0, 64]) {
      const result = await verifyCheckpointChain({
        checkpoints: [await buildCheckpoint(3n, 7n)],
        verifySignature: verifySig,
        trustedBase: {
          size: 3n,
          accumulator: [new Uint8Array(length).fill(7)],
        },
      });
      expect(result.ok, `peak of ${length} bytes`).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("proof_malformed");
    }
  });

  it("rejects a trusted base peak that is not bytes at all", async () => {
    const result = await verifyCheckpointChain({
      checkpoints: [await buildCheckpoint(3n, 7n)],
      verifySignature: verifySig,
      trustedBase: {
        size: 3n,
        accumulator: [null as unknown as Uint8Array],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("proof_malformed");
    expect(result.detail).toMatch(/null/);
  });

  it("the genuine 32-byte base peaks still verify", async () => {
    const result = await verifyCheckpointChain({
      checkpoints: [await buildCheckpoint(3n, 7n)],
      verifySignature: verifySig,
      trustedBase: { size: 3n, accumulator: peaksAt(2n) },
    });
    expect(result.ok).toBe(true);
  });
});
