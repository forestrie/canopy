/**
 * Self-created SCITT receipts from local artifacts.
 *
 * Mirrors canopy-api resolve-receipt receipt assembly, but over local massif
 * (`.log`) and checkpoint (`.sth`) bytes instead of R2 objects. The checkpoint
 * signature covers only the accumulator, so the inclusion path is free to
 * rebuild client-side: read massif nodes, build the leaf→peak path, attach it
 * at header 396 to the checkpoint's pre-signed peak receipt. The result is
 * verify-equivalent with an API-issued receipt (FOR-334 AC: both pass
 * verifyGrantReceiptOffline identically; byte-equality is intentionally not
 * claimed — encoder-level variation is known-benign, see plan-2607-15 §2).
 *
 * `computeAccumulatorPeak` supports the chain-anchored variant: build the path
 * at an externally attested tree size (e.g. Univocity `logState` on Base
 * Sepolia) and compare the computed peak with the published accumulator.
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import {
  calculateRoot,
  inclusionProof,
  massifIndexFromMMRIndex,
  openMassifNodeStore,
  peakIndexForLeafProof,
  type MassifNodeStore,
  type Proof,
} from "@forestrie/merklelog";
import {
  requireCoseSign1,
  toHeaderMap,
  unwrapCoseSign1Tag,
  type CoseSign1,
} from "./parse-receipt.js";
import { SubtleHasher } from "./subtle-hasher.js";

const VDS_COSE_RECEIPT_PROOFS_TAG = 396;
const SEAL_PEAK_RECEIPTS_LABEL = -65931;
const DELEGATION_CERT_LABEL = 1000;
const VDP_CONSISTENCY_PROOF_KEY = -2;

/**
 * Re-exported for compatibility. The MMR proof math and massif node store now
 * live in `@forestrie/merklelog` (plan-2607-15 §4, phase 2); receipt-verify
 * keeps only the COSE-shaped layer below.
 */
export { openMassifNodeStore };
export type { MassifNodeStore };

export type ParsedCheckpoint = {
  coseSign1: CoseSign1;
  unprotected: Map<number, unknown>;
  /** Pre-signed peak receipts (label -65931), or null when absent. */
  peakReceipts: unknown[] | null;
  /** Sealed tree size (tree-size-2 of the embedded consistency proof). */
  mmrSize: bigint | null;
  delegationCert: Uint8Array | null;
};

/** Parse a format-v3 checkpoint (`.sth`) COSE Sign1. */
export function parseCheckpoint(checkpointBytes: Uint8Array): ParsedCheckpoint {
  const decoded = decodeCbor(checkpointBytes) as unknown;
  const coseSign1 = requireCoseSign1(unwrapCoseSign1Tag(decoded));
  const unprotected = toHeaderMap(coseSign1[1]);

  const peakReceiptsRaw = unprotected.get(SEAL_PEAK_RECEIPTS_LABEL);
  const peakReceipts = Array.isArray(peakReceiptsRaw) ? peakReceiptsRaw : null;

  const delegationCertRaw = unprotected.get(DELEGATION_CERT_LABEL);
  const delegationCert =
    delegationCertRaw instanceof Uint8Array && delegationCertRaw.length > 0
      ? delegationCertRaw
      : null;

  return {
    coseSign1,
    unprotected,
    peakReceipts,
    mmrSize: sealedSizeFromCheckpoint(unprotected),
    delegationCert,
  };
}

export type BuildReceiptOfflineInput = {
  massifBytes: Uint8Array;
  checkpointBytes: Uint8Array;
  mmrIndex: bigint;
};

/**
 * Assemble a receipt for the entry at `mmrIndex` from a local massif blob and
 * its checkpoint. Pure over bytes; no network, no signing key — the signature
 * is the checkpoint's pre-signed peak receipt. Throws with a specific reason
 * on any failure.
 */
export function buildReceiptOffline(
  input: BuildReceiptOfflineInput,
): Uint8Array {
  const { mmrIndex } = input;
  if (mmrIndex < 0n) {
    throw new Error("mmrIndex must be non-negative");
  }

  const checkpoint = parseCheckpoint(input.checkpointBytes);
  if (!checkpoint.peakReceipts) {
    throw new Error(
      "checkpoint carries no pre-signed peak receipts (label -65931)",
    );
  }
  if (checkpoint.mmrSize === null || checkpoint.mmrSize <= 0n) {
    throw new Error(
      "checkpoint carries no consistency proof (cannot determine sealed size)",
    );
  }
  const mmrSize = checkpoint.mmrSize;
  const mmrLastIndex = mmrSize - 1n;
  if (mmrIndex > mmrLastIndex) {
    throw new Error(
      `checkpoint does not cover entry: mmrIndex ${mmrIndex.toString(10)} ` +
        `>= sealed size ${mmrSize.toString(10)}`,
    );
  }

  const store = openMassifNodeStore(input.massifBytes);
  const expectedMassifIndex = massifIndexFromMMRIndex(
    store.massifHeight,
    mmrIndex,
  );
  if (expectedMassifIndex !== store.massifIndex) {
    throw new Error(
      `entry at mmrIndex ${mmrIndex.toString(10)} lives in massif ` +
        `${expectedMassifIndex.toString(10)}, but this blob is massif ` +
        `${store.massifIndex.toString(10)}`,
    );
  }

  const proof = inclusionProof(store.get, mmrLastIndex, mmrIndex);
  const peakIdx = peakIndexForLeafProof(mmrSize, proof.length);
  const receiptBytes = checkpoint.peakReceipts[peakIdx];
  if (!(receiptBytes instanceof Uint8Array)) {
    throw new Error(
      `checkpoint peak receipt slot ${peakIdx} is missing or not bstr`,
    );
  }

  const receiptSign1 = requireCoseSign1(
    unwrapCoseSign1Tag(decodeCbor(receiptBytes) as unknown),
  );
  const receiptUnprotected = toHeaderMap(receiptSign1[1]);

  if (checkpoint.delegationCert) {
    receiptUnprotected.set(DELEGATION_CERT_LABEL, checkpoint.delegationCert);
  }

  const inclusionProofEntry = new Map<number, unknown>([
    [1, mmrIndex],
    [2, proof],
  ]);
  const verifiableProofs = new Map<number, unknown>([
    [-1, [inclusionProofEntry]],
  ]);
  receiptUnprotected.set(VDS_COSE_RECEIPT_PROOFS_TAG, verifiableProofs);

  // Peak receipts are signed with detached payload; emit nil so verify uses
  // the peak derived from the inclusion proof.
  const assembled: CoseSign1 = [
    receiptSign1[0],
    receiptUnprotected,
    null,
    receiptSign1[3],
  ];
  return cborBytes(assembled);
}

export type ComputedAccumulatorPeak = {
  /** Root computed from the massif's leaf value and rebuilt path. */
  peak: Uint8Array;
  /** Position of that peak in the accumulator, left to right. */
  peakIndex: number;
  proof: Uint8Array[];
  leafValue: Uint8Array;
};

/**
 * Chain-anchored variant: rebuild the inclusion path for `mmrIndex` at an
 * externally attested tree size and compute the accumulator peak it commits
 * to. Compare `peak` with `accumulator[peakIndex]` published by the Univocity
 * contract (`logState`). Requires the local massif to hold nodes up to
 * `mmrSize`.
 */
export async function computeAccumulatorPeak(opts: {
  massifBytes: Uint8Array;
  mmrIndex: bigint;
  mmrSize: bigint;
}): Promise<ComputedAccumulatorPeak> {
  const { mmrIndex, mmrSize } = opts;
  if (mmrSize <= 0n || mmrIndex >= mmrSize) {
    throw new Error(
      `mmrIndex ${mmrIndex.toString(10)} is not covered by tree size ` +
        `${mmrSize.toString(10)} (entry not anchored yet?)`,
    );
  }
  const store = openMassifNodeStore(opts.massifBytes);
  const leafValue = store.get(mmrIndex);
  const path = inclusionProof(store.get, mmrSize - 1n, mmrIndex);
  const proof: Proof = { path, mmrIndex };
  const peak = await calculateRoot(
    new SubtleHasher(),
    leafValue,
    proof,
    mmrIndex,
  );
  return {
    peak,
    peakIndex: peakIndexForLeafProof(mmrSize, path.length),
    proof: path,
    leafValue,
  };
}

// --- helpers ---

function cborBytes(value: unknown): Uint8Array {
  const encoded = encodeCbor(value);
  return encoded instanceof Uint8Array
    ? encoded
    : new Uint8Array(encoded as ArrayLike<number>);
}

/**
 * Sealed mmr size from a format-v3 checkpoint: tree-size-2 of the consistency
 * proof (`bstr .cbor [tree-size-1, tree-size-2, paths, right-peaks]`) under
 * the verifiable-proofs unprotected header (label 396, key -2).
 */
function sealedSizeFromCheckpoint(
  unprotected: Map<number, unknown>,
): bigint | null {
  const vdpRaw = unprotected.get(VDS_COSE_RECEIPT_PROOFS_TAG);
  if (vdpRaw === undefined || vdpRaw === null) return null;
  const vdp = toHeaderMap(vdpRaw as Map<number, unknown>);
  const proofBstr = vdp.get(VDP_CONSISTENCY_PROOF_KEY);
  if (!(proofBstr instanceof Uint8Array)) return null;
  const proof = decodeCbor(proofBstr) as unknown;
  if (!Array.isArray(proof) || proof.length < 2) return null;
  const treeSize2 = proof[1];
  if (typeof treeSize2 === "bigint") return treeSize2;
  if (typeof treeSize2 === "number" && Number.isSafeInteger(treeSize2)) {
    return BigInt(treeSize2);
  }
  return null;
}
