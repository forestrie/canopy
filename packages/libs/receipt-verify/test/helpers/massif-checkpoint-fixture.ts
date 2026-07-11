/**
 * Minimal v2 massif + format-v3 checkpoint blobs for buildReceiptOffline
 * tests. Layout mirrors canopy-api test/helpers/mmrs-r2-fixture.ts and
 * resolve-receipt.ts.
 */

import { encodeSigStructure } from "@forestrie/encoding";
import { encode as encodeCbor } from "cbor-x";

export const SEAL_PEAK_RECEIPTS_LABEL = -65931;

const VALUE_BYTES = 32;
const RESERVED_HEADER_SLOTS = 7;
const INDEX_HEADER_BYTES = 32;
const MAX_MMR_HEIGHT = 64;
const BLOOM_BITS_PER_ELEMENT_V1 = 10;
const BLOOM_FILTERS = 4;
const BLOOM_HEADER_BYTES_V1 = 32;
const URKLE_FRONTIER_STATE_V1_BYTES = 544;
const URKLE_LEAF_RECORD_BYTES = 128;
const URKLE_NODE_RECORD_BYTES = 64;

function cborBytes(value: unknown): Uint8Array {
  const encoded = encodeCbor(value);
  return encoded instanceof Uint8Array
    ? encoded
    : new Uint8Array(encoded as ArrayLike<number>);
}

/**
 * Build v2 massif bytes with `logHashes[i]` at MMR log index i (32-byte nodes).
 */
export function buildV2MassifBytes(opts: {
  massifHeight: number;
  massifIndex: number;
  logHashes: Uint8Array[];
}): Uint8Array {
  const { massifHeight, massifIndex, logHashes } = opts;
  const leafCount = 1 << (massifHeight - 1);
  const mBits = BLOOM_BITS_PER_ELEMENT_V1 * leafCount;
  const bitsetBytes = Math.ceil(mBits / 8);
  const bloomRegionBytes = BLOOM_HEADER_BYTES_V1 + BLOOM_FILTERS * bitsetBytes;
  const bloomBitsetsBytes = bloomRegionBytes - BLOOM_HEADER_BYTES_V1;
  const leafTableBytes = leafCount * URKLE_LEAF_RECORD_BYTES;
  const nodeStoreBytes = (2 * leafCount - 1) * URKLE_NODE_RECORD_BYTES;
  const indexDataBytes =
    bloomBitsetsBytes +
    URKLE_FRONTIER_STATE_V1_BYTES +
    leafTableBytes +
    nodeStoreBytes;

  const fixedHeaderEnd = VALUE_BYTES + VALUE_BYTES * RESERVED_HEADER_SLOTS;
  const trieHeaderEnd = fixedHeaderEnd + INDEX_HEADER_BYTES;
  const peakStackStart = trieHeaderEnd + indexDataBytes;
  const logStart = peakStackStart + MAX_MMR_HEIGHT * VALUE_BYTES;

  const massifBytes = new Uint8Array(logStart + logHashes.length * VALUE_BYTES);
  const view = new DataView(massifBytes.buffer);

  view.setBigUint64(8, 0n, false);
  view.setUint16(21, 2, false);
  view.setUint32(23, 1, false);
  massifBytes[27] = massifHeight;
  view.setUint32(28, massifIndex, false);

  for (let i = 0; i < logHashes.length; i++) {
    const h = logHashes[i]!;
    if (h.length !== 32) {
      throw new Error(`logHashes[${i}] must be 32 bytes`);
    }
    massifBytes.set(h, logStart + i * VALUE_BYTES);
  }

  return massifBytes;
}

export function buildV2CheckpointBytes(opts: {
  mmrSize: bigint;
  peakReceipts: Uint8Array[];
  delegationCert?: Uint8Array;
}): Uint8Array {
  // Checkpoint format v3 (ADR-0046): detached (null) payload; the sealed
  // size travels as tree-size-2 of the consistency proof under the
  // verifiable-proofs unprotected header (label 396, key -2).
  const consistencyProof = cborBytes([0n, opts.mmrSize, [], []]);
  const verifiableProofs = new Map<number, unknown>([[-2, consistencyProof]]);
  const checkpointUnprotected = new Map<number, unknown>([
    [396, verifiableProofs],
    [SEAL_PEAK_RECEIPTS_LABEL, opts.peakReceipts],
  ]);
  if (opts.delegationCert?.length) {
    checkpointUnprotected.set(1000, opts.delegationCert);
  }
  return cborBytes([
    new Uint8Array(),
    checkpointUnprotected,
    null,
    new Uint8Array(),
  ]);
}

/** 8-byte big-endian, matching go `HashWriteUint64`. */
export function u64BigEndian(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value & 0xffffffffffffffffn;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Interior MMR node hash the go-merklelog / spec way:
 * `H(pos_BE8 || left || right)` where `pos` is the 1-based node position.
 * Built directly via crypto.subtle so fixtures are independent of the
 * implementation under test.
 */
export async function positionCommittedInteriorHash(
  pos: bigint,
  left: Uint8Array,
  right: Uint8Array,
): Promise<Uint8Array> {
  const combined = new Uint8Array(8 + left.length + right.length);
  combined.set(u64BigEndian(pos), 0);
  combined.set(left, 8);
  combined.set(right, 8 + left.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", combined));
}

/**
 * Raw pre-signed peak receipt as the sealer emits into the checkpoint:
 * detached (nil) payload, NO header 396 — the inclusion proof is attached by
 * the receipt builder.
 */
export async function signDetachedPeakReceipt(
  signer: CryptoKeyPair,
  peak: Uint8Array,
): Promise<Uint8Array> {
  const protectedInner = cborBytes(new Map<number, unknown>([[1, -7]]));
  const sigStructure = encodeSigStructure(
    protectedInner,
    new Uint8Array(0),
    peak,
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signer.privateKey,
      sigStructure.buffer.slice(
        sigStructure.byteOffset,
        sigStructure.byteOffset + sigStructure.byteLength,
      ) as ArrayBuffer,
    ),
  );
  return cborBytes([protectedInner, new Map<number, unknown>(), null, sig]);
}
