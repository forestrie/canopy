/**
 * Multi-proof Receipt of Consistency (FOR-568, review finding I7;
 * ADR-0066 D2): a checkpoint relays a chain of sealed steps under ONE
 * signature, carried by the draft's
 * `consistency-proofs = [ + consistency-proof ]` under vdp key -2.
 *
 * The receipts here are assembled from `checkpoint-receipt-kat39.json` —
 * the canonical 39-node MMR, its tabulated accumulators and its
 * `consistency_pairs` rows — and signed with the vector's own ES256 key, so
 * every node value and every path in them is a value the cross-language
 * vectors already pin. The chain used is 1 -> 3 -> 4 -> 7, which exercises
 * all three shapes a fold can meet: a proven path (1 -> 3), an above-split
 * peak whose path is empty alongside a supplied right-peak (3 -> 4), and a
 * two-peak origin folding to one (4 -> 7).
 *
 * The vector file is read, never written: these receipts are built at run
 * time from its rows. The vector's own `receipts` rows — single proofs
 * written straight under -2 — stay exactly as they are and are covered by
 * checkpoint-receipt-kat39.test.ts.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  COSE_LABEL_TREE_SIZE_2,
  COSE_LABEL_VDP,
  COSE_LABEL_VDS,
  VDP_CONSISTENCY_PROOF_KEY,
  VDS_MMR_CONSISTENCY,
  encodeCborDeterministic,
  encodeSigStructure,
  verifyCoseSign1WithParsedKey,
  type ParsedEcPublicKey,
} from "@forestrie/encoding";
import {
  checkpointConsistencyProof,
  verifyCheckpointChain,
} from "../src/checkpoint-chain.js";
import { EmptyConsistencyProofsError } from "../src/decode-checkpoint-consistency-proof.js";
import { toLowS } from "./helpers/to-low-s.js";

const dir = dirname(fileURLToPath(import.meta.url));

interface ConsistencyPairRow {
  name: string;
  tree_size_1: number;
  tree_size_2: number;
  paths_hex: string[][];
  right_peaks_hex: string[];
}

const vector = JSON.parse(
  readFileSync(
    join(
      dir,
      "..",
      "..",
      "..",
      "shared",
      "encoding",
      "src",
      "testdata",
      "checkpoint-receipt-kat39.json",
    ),
    "utf8",
  ),
) as {
  tree: { accumulators: Record<string, { peaks_hex: string[] }> };
  keys: {
    es256: { private_hex: string; public_x_hex: string; public_y_hex: string };
  };
  consistency_pairs: ConsistencyPairRow[];
};

const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const b64url = (hex: string) => Buffer.from(hex, "hex").toString("base64url");

const es256Key: ParsedEcPublicKey = {
  x: fromHex(vector.keys.es256.public_x_hex),
  y: fromHex(vector.keys.es256.public_y_hex),
  curve: "P-256",
};
const verifySignature = (bytes: Uint8Array, detachedPayload: Uint8Array) =>
  verifyCoseSign1WithParsedKey(bytes, es256Key, { detachedPayload });

/** The vector's tabulated accumulator at `size`. */
function accumulatorAt(size: number): Uint8Array[] {
  const entry = vector.tree.accumulators[String(size)];
  expect(entry, `no tree.accumulators entry for size ${size}`).toBeDefined();
  return entry!.peaks_hex.map(fromHex);
}

/** The detached payload for `size`: its accumulator peaks concatenated with
 * no framing (ADR-0046, and the vector's `conventions.detached_payload`). */
function payloadAt(size: number): Uint8Array {
  return Buffer.concat(accumulatorAt(size).map((p) => Buffer.from(p)));
}

/** A step of the relay, from the vector's `consistency_pairs` row. */
type Step = {
  treeSize1: bigint;
  treeSize2: bigint;
  paths: Uint8Array[][];
  rightPeaks: Uint8Array[];
};

function step(from: number, to: number): Step {
  const row = vector.consistency_pairs.find(
    (p) => p.tree_size_1 === from && p.tree_size_2 === to,
  );
  expect(row, `no consistency_pairs row ${from}-to-${to}`).toBeDefined();
  return {
    treeSize1: BigInt(row!.tree_size_1),
    treeSize2: BigInt(row!.tree_size_2),
    paths: row!.paths_hex.map((path) => path.map(fromHex)),
    rightPeaks: row!.right_peaks_hex.map(fromHex),
  };
}

const proofBstr = (s: Step) =>
  encodeCborDeterministic([s.treeSize1, s.treeSize2, s.paths, s.rightPeaks]);

let privateKey: CryptoKey;

beforeAll(async () => {
  privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: b64url(vector.keys.es256.private_hex),
      x: b64url(vector.keys.es256.public_x_hex),
      y: b64url(vector.keys.es256.public_y_hex),
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
});

/**
 * Build a signed checkpoint receipt whose -2 entry is `entry` (the array of
 * proof bstrs, or a single bstr for the pre-array shape) and whose signature
 * covers `signedSize`'s accumulator.
 */
async function receipt(opts: {
  entry: unknown;
  signedSize: number;
  /** The size whose accumulator the signature covers; `signedSize` when the
   * receipt is well formed. */
  payloadSize?: number;
}): Promise<Uint8Array> {
  const protectedBstr = encodeCborDeterministic(
    new Map<number, unknown>([
      [1, -7],
      [COSE_LABEL_VDS, VDS_MMR_CONSISTENCY],
      [COSE_LABEL_TREE_SIZE_2, BigInt(opts.signedSize)],
    ]),
  );
  const payload = payloadAt(opts.payloadSize ?? opts.signedSize);
  const sigStructure = encodeSigStructure(
    protectedBstr,
    new Uint8Array(0),
    payload,
  );
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      sigStructure.buffer.slice(
        sigStructure.byteOffset,
        sigStructure.byteOffset + sigStructure.byteLength,
      ) as ArrayBuffer,
    ),
  );
  return encodeCborDeterministic([
    protectedBstr,
    new Map<number, unknown>([
      [
        COSE_LABEL_VDP,
        new Map<number, unknown>([[VDP_CONSISTENCY_PROOF_KEY, opts.entry]]),
      ],
    ]),
    null,
    toLowS(raw),
  ]);
}

const chain139_1_3_4_7 = () => [step(1, 3), step(3, 4), step(4, 7)];

const trustedBaseAt1 = () => ({ size: 1n, accumulator: accumulatorAt(1) });

describe("a receipt relaying three consistency proofs (ADR-0066 D2)", () => {
  it("folds 1 -> 3 -> 4 -> 7 under one signature and verifies end to end", async () => {
    const steps = chain139_1_3_4_7();
    const bytes = await receipt({
      entry: steps.map(proofBstr),
      signedSize: 7,
    });

    const decoded = checkpointConsistencyProof(bytes);
    expect(decoded.proofs.map((p) => [p.treeSize1, p.treeSize2])).toEqual([
      [1n, 3n],
      [3n, 4n],
      [4n, 7n],
    ]);
    // The signed size is the LAST proof's, and the base reported for the
    // chain is the FIRST proof's.
    expect(decoded.signedTreeSize2).toBe(7n);
    expect(decoded.treeSize2).toBe(7n);
    expect(decoded.treeSize1).toBe(1n);

    const result = await verifyCheckpointChain({
      checkpoints: [bytes],
      verifySignature,
      trustedBase: trustedBaseAt1(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The fold reaches the vector's tabulated size-7 accumulator, and the
    // signature is over exactly that — so the intermediate sizes 3 and 4,
    // which no signature names, were reconstructed rather than trusted.
    expect(result.accumulator.map(toHex)).toEqual(accumulatorAt(7).map(toHex));
    expect(result.links.length).toBe(1);
    expect(result.links[0]!.treeSize2).toBe(7n);
  });

  it("reaches the same accumulator as the single 1 -> 7 proof of the same tree", async () => {
    const relayed = await verifyCheckpointChain({
      checkpoints: [
        await receipt({
          entry: chain139_1_3_4_7().map(proofBstr),
          signedSize: 7,
        }),
      ],
      verifySignature,
      trustedBase: trustedBaseAt1(),
    });
    const direct = await verifyCheckpointChain({
      checkpoints: [
        await receipt({ entry: [proofBstr(step(1, 7))], signedSize: 7 }),
      ],
      verifySignature,
      trustedBase: trustedBaseAt1(),
    });
    expect(relayed.ok).toBe(true);
    expect(direct.ok).toBe(true);
    if (!relayed.ok || !direct.ok) return;
    expect(relayed.accumulator.map(toHex)).toEqual(
      direct.accumulator.map(toHex),
    );
  });

  it("rejects a middle proof whose tree-size-1 is one short of the previous proof's size", async () => {
    // 1 -> 3, then 2 -> 4: the second step claims a base the first did not
    // reach. Only the last size is signed, so the relay holds together by
    // this comparison alone.
    const steps = chain139_1_3_4_7();
    steps[1] = { ...steps[1]!, treeSize1: 2n };
    const result = await verifyCheckpointChain({
      checkpoints: [
        await receipt({ entry: steps.map(proofBstr), signedSize: 7 }),
      ],
      verifySignature,
      trustedBase: trustedBaseAt1(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("size_mismatch");
    expect(result.at).toBe(0);
    expect(result.detail).toContain("entry 1");
    expect(result.detail).toContain("2");
    expect(result.detail).toContain("3");
  });

  it("rejects proofs relayed out of order", async () => {
    // The same three proofs, with the last two swapped: 1 -> 3, 4 -> 7,
    // 3 -> 4. Every proof is individually genuine, and the last size still
    // matches the signature; the chain is what is wrong.
    const [a, b, c] = chain139_1_3_4_7();
    const result = await verifyCheckpointChain({
      checkpoints: [
        await receipt({
          entry: [a!, c!, b!].map(proofBstr),
          signedSize: 4,
          payloadSize: 4,
        }),
      ],
      verifySignature,
      trustedBase: trustedBaseAt1(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("size_mismatch");
    expect(result.detail).toContain("entry 1");
  });

  it("rejects a signed tree-size-2 taken from a middle proof instead of the last", async () => {
    // Signed for size 4 — the size the relay passes THROUGH — while the
    // relay reaches 7. The signature would then cover an accumulator the
    // receipt does not end at.
    const result = await verifyCheckpointChain({
      checkpoints: [
        await receipt({
          entry: chain139_1_3_4_7().map(proofBstr),
          signedSize: 4,
        }),
      ],
      verifySignature,
      trustedBase: trustedBaseAt1(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("size_mismatch");
    expect(result.detail).toContain("4");
    expect(result.detail).toContain("7");
  });

  it("rejects an empty consistency-proofs array", async () => {
    // `[ + consistency-proof ]` requires at least one. The key is present,
    // so this is not an absent proof: there is simply no last proof for the
    // signed size to equal and nothing to fold.
    const bytes = await receipt({ entry: [], signedSize: 7 });
    expect(() => checkpointConsistencyProof(bytes)).toThrow(
      EmptyConsistencyProofsError,
    );
    const result = await verifyCheckpointChain({
      checkpoints: [bytes],
      verifySignature,
      trustedBase: trustedBaseAt1(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("proof_malformed");
    expect(result.detail).toContain("empty");
  });

  it("rejects a consistency-proofs entry that is not a byte string", async () => {
    const bytes = await receipt({
      entry: [proofBstr(step(1, 3)), 7n],
      signedSize: 7,
    });
    expect(() => checkpointConsistencyProof(bytes)).toThrow(
      /entry 1 is not a byte string/,
    );
  });

  it("names the offending entry when one relayed proof is malformed", async () => {
    const steps = chain139_1_3_4_7();
    const bad = encodeCborDeterministic([
      steps[1]!.treeSize1,
      steps[1]!.treeSize2,
      steps[1]!.paths,
      [new Uint8Array(31).fill(1)],
    ]);
    const bytes = await receipt({
      entry: [proofBstr(steps[0]!), bad, proofBstr(steps[2]!)],
      signedSize: 7,
    });
    expect(() => checkpointConsistencyProof(bytes)).toThrow(
      /consistency-proofs entry 1: right-peaks: expected an array of 32-byte strings/,
    );
  });
});

describe("a receipt carrying one consistency proof", () => {
  it("verifies identically whether the proof is written under -2 directly or as the array of one", async () => {
    // The shape every checkpoint sealed before the array form carries, and
    // the shape `checkpoint-receipt-kat39.json`'s `conventions.receipt`
    // states, alongside the draft's array. Both are the relay of one.
    const only = step(1, 7);
    const bare = await receipt({ entry: proofBstr(only), signedSize: 7 });
    const wrapped = await receipt({ entry: [proofBstr(only)], signedSize: 7 });

    // The bytes differ — one array header — so this is a genuine second
    // wire shape, not the same encoding reached twice.
    expect(toHex(bare)).not.toBe(toHex(wrapped));

    for (const bytes of [bare, wrapped]) {
      const decoded = checkpointConsistencyProof(bytes);
      expect(decoded.proofs.length).toBe(1);
      expect(decoded.treeSize1).toBe(1n);
      expect(decoded.treeSize2).toBe(7n);
      const result = await verifyCheckpointChain({
        checkpoints: [bytes],
        verifySignature,
        trustedBase: trustedBaseAt1(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.accumulator.map(toHex)).toEqual(
        accumulatorAt(7).map(toHex),
      );
    }
  });

  it("reports a malformed single proof without naming an entry position", async () => {
    const bytes = await receipt({
      entry: [encodeCborDeterministic([7n, 3n, [], []])],
      signedSize: 7,
    });
    expect(() => checkpointConsistencyProof(bytes)).toThrow(
      /^consistency proof must grow the tree/,
    );
  });
});
