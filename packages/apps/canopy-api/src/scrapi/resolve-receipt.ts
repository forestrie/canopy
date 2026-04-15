/**
 * Resolve Receipt operation for SCRAPI.
 *
 * Permanent receipt URL shape:
 *   /logs/{bootstrapLogId}/{logId}/{massifHeight}/entries/{entryId}/receipt
 *
 * entryId is a 16-byte value encoded as 32 hex characters:
 *   entryId = hex( idtimestamp_be8 || mmrIndex_be8 )
 *
 * Receipt assembly:
 * - Determine the massif index from (mmrIndex, massifHeight).
 * - Fetch the latest checkpoint for that massif.
 * - Extract the pre-signed peak receipts from the checkpoint.
 * - Read the inclusion proof path for mmrIndex from the massif blob.
 * - Attach the inclusion proof to the appropriate peak receipt at header label 396.
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";

import { CBOR_CONTENT_TYPES } from "../cbor-api/cbor-content-types.js";
import { cborResponse } from "../cbor-api/cbor-response.js";
import { decodeEntryId, isEntryIdHex } from "./entry-id";
import { ClientErrors, ServerErrors } from "../cbor-api/problem-details.js";
import { logIdSegmentToCanonicalUuid } from "../grant/log-id-wire.js";
import { getParsedGenesis } from "../forest/genesis-cache.js";

// COSE / MMRIVER constants (mirrors go-merklelog/massifs/rootsigner.go)
const VDS_COSE_RECEIPT_PROOFS_TAG = 396;
const SEAL_PEAK_RECEIPTS_LABEL = -65931;
/** Delegation certificate unprotected header label (sealer embeds via Custodian per-log delegation). */
const DELEGATION_CERT_LABEL = 1000;

function isUintDecimal(id: string): boolean {
  return /^[0-9]+$/.test(id);
}

type CoseSign1 = [
  protectedHeader: Uint8Array,
  unprotectedHeader: Map<number, unknown> | Record<string, unknown>,
  payload: Uint8Array | null,
  signature: Uint8Array,
];

/**
 * Resolve a receipt for a registered statement.
 *
 * @param entrySegments - [bootstrapLogId, logId, massifHeight, 'entries', entryId, 'receipt']
 */
export async function resolveReceipt(
  _request: Request,
  entrySegments: string[],
  mmrs: R2Bucket,
  r2Grants: R2Bucket,
): Promise<Response> {
  const [
    bootstrapSeg,
    logIDRaw,
    massifHeightRaw,
    entriesLiteral,
    entryIdRaw,
    receiptLiteral,
  ] = entrySegments;

  try {
    const genesisLookup = await getParsedGenesis(bootstrapSeg!, {
      R2_GRANTS: r2Grants,
    });
    if ("kind" in genesisLookup && genesisLookup.kind === "bad_segment") {
      return ClientErrors.badRequest("Invalid bootstrap log-id in path");
    }
    if ("kind" in genesisLookup && genesisLookup.kind === "not_found") {
      return ClientErrors.notFound(
        "Not Found",
        "Forest genesis not found for bootstrap log-id in path",
      );
    }
    if ("kind" in genesisLookup && genesisLookup.kind === "corrupt") {
      return ServerErrors.internal("Stored genesis for this forest is invalid");
    }

    let logID: string;
    try {
      logID = logIdSegmentToCanonicalUuid(logIDRaw!);
    } catch {
      return ClientErrors.badRequest("logId in path must be a valid log id");
    }
    if (entriesLiteral !== "entries") {
      return ClientErrors.notFound(`Entry ${logID} not found`);
    }
    if (receiptLiteral !== "receipt") {
      return ClientErrors.notFound(
        `Entry ${logID} not found (missing /receipt suffix)`,
      );
    }

    if (!massifHeightRaw || !isUintDecimal(massifHeightRaw)) {
      return ClientErrors.badRequest("massifHeight must be an integer");
    }
    const massifHeight = Number.parseInt(massifHeightRaw, 10);
    if (
      !Number.isInteger(massifHeight) ||
      massifHeight < 1 ||
      massifHeight > 64
    ) {
      return ClientErrors.badRequest("massifHeight must be in range 1..64");
    }

    if (!entryIdRaw || !isEntryIdHex(entryIdRaw)) {
      return ClientErrors.badRequest(
        "entryId must be exactly 16 bytes (32 hex characters)",
      );
    }

    const { mmrIndex } = decodeEntryId(entryIdRaw);

    const massifIndex = massifIndexFromMMRIndex(massifHeight, mmrIndex);
    const objectIndex = formatObjectIndex16(massifIndex);

    const checkpointKey = `v2/merklelog/checkpoints/${massifHeight}/${logID}/${objectIndex}.sth`;
    const massifKey = `v2/merklelog/massifs/${massifHeight}/${logID}/${objectIndex}.log`;

    const checkpointObject = await mmrs.get(checkpointKey);
    if (!checkpointObject) {
      return ClientErrors.notFound(
        "Entry receipt not found (checkpoint missing)",
      );
    }

    const checkpointBytes = new Uint8Array(
      await checkpointObject.arrayBuffer(),
    );
    const checkpointDecoded = decodeCbor(checkpointBytes) as unknown;
    const checkpoint = unwrapCoseSign1Tag(checkpointDecoded, "checkpoint");

    // Temporary diagnostics to understand real-world checkpoint encoding.
    console.log("[resolve-receipt] decoded checkpoint shape", {
      type: typeof checkpointDecoded,
      isArray: Array.isArray(checkpointDecoded),
      isMap: checkpointDecoded instanceof Map,
      mapKeys:
        checkpointDecoded instanceof Map
          ? Array.from(checkpointDecoded.keys())
          : undefined,
      objectKeys:
        checkpointDecoded &&
        typeof checkpointDecoded === "object" &&
        !(checkpointDecoded instanceof Map)
          ? Object.keys(checkpointDecoded as any)
          : undefined,
    });

    const checkpointSign1 = requireCoseSign1(checkpoint, "checkpoint");

    const checkpointUnprotected = toHeaderMap(checkpointSign1[1]);
    console.log("[resolve-receipt] checkpoint unprotected header keys", {
      rawType: typeof checkpointSign1[1],
      isMap: checkpointSign1[1] instanceof Map,
      keys: Array.from(checkpointUnprotected.keys()),
      hasDelegationCert: checkpointUnprotected.has(DELEGATION_CERT_LABEL),
      delegationCertType: typeof checkpointUnprotected.get(DELEGATION_CERT_LABEL),
    });
    const peakReceiptsRaw = checkpointUnprotected.get(SEAL_PEAK_RECEIPTS_LABEL);
    if (!Array.isArray(peakReceiptsRaw)) {
      return ClientErrors.notFound(
        "Entry receipt not found (checkpoint missing peak receipts)",
      );
    }

    const peakReceipts = peakReceiptsRaw as unknown[];

    const checkpointPayload = checkpointSign1[2];
    if (!(checkpointPayload instanceof Uint8Array)) {
      return ClientErrors.notFound(
        "Entry receipt not found (checkpoint payload missing)",
      );
    }

    const state = decodeCbor(checkpointPayload) as unknown;
    const mmrSize = readStateMMRSize(state);
    if (mmrSize <= 0n) {
      return ClientErrors.notFound(
        "Entry receipt not found (invalid MMR size)",
      );
    }

    const mmrLastIndex = mmrSize - 1n;
    if (mmrIndex > mmrLastIndex) {
      return ClientErrors.notFound(
        "Entry receipt not found (checkpoint does not cover entry)",
      );
    }

    const massifObject = await mmrs.get(massifKey);
    if (!massifObject) {
      return ClientErrors.notFound("Entry receipt not found (massif missing)");
    }

    const massifBytes = new Uint8Array(await massifObject.arrayBuffer());
    const massifHeader = readMassifStart(massifBytes);

    if (massifHeader.massifHeight !== massifHeight) {
      return ClientErrors.notFound(
        "Entry receipt not found (massif height mismatch)",
      );
    }

    if (BigInt(massifHeader.massifIndex) !== massifIndex) {
      return ClientErrors.notFound(
        "Entry receipt not found (massif index mismatch)",
      );
    }

    const firstIndex = massifFirstLeaf(massifHeader.massifHeight, massifIndex);

    const peakStackMap = peakStackMapForMassif(massifHeight, firstIndex);

    const { peakStackStart, logStart } = v2OffsetsForMassif(massifHeight);

    const store: IndexStoreGetter = {
      get: (i) => {
        if (i >= firstIndex) {
          const localIndex = i - firstIndex;
          const off = logStart + localIndex * 32n;
          return slice32(massifBytes, off, "log-data");
        }

        // Ancestor peak in the fixed peak-stack region.
        const peakIdx = peakStackMap.get(i);
        if (peakIdx === undefined) {
          throw new Error(
            `missing ancestor peak for mmr index ${i.toString(10)}`,
          );
        }

        const off = peakStackStart + BigInt(peakIdx) * 32n;
        return slice32(massifBytes, off, "peak-stack");
      },
    };

    const proof = inclusionProof(store, mmrLastIndex, mmrIndex);
    const peakIndex = peakIndexForLeafProof(mmrSize, proof.length);

    const receiptBytes = peakReceipts[peakIndex];
    if (!(receiptBytes instanceof Uint8Array)) {
      return ClientErrors.notFound(
        "Entry receipt not found (invalid peak receipt encoding)",
      );
    }

    const receiptDecoded = decodeCbor(receiptBytes) as unknown;
    const receipt = unwrapCoseSign1Tag(receiptDecoded, "peak receipt");
    const receiptSign1 = requireCoseSign1(receipt, "peak receipt");

    const receiptUnprotected = toHeaderMap(receiptSign1[1]);

    // Copy delegation certificate from checkpoint to receipt.
    // The sealer embeds the delegation cert only in the checkpoint unprotected header, not in individual
    // peak receipts. Receipt verification requires this cert to resolve the signing key chain.
    const delegationCertBytes = checkpointUnprotected.get(DELEGATION_CERT_LABEL);
    if (delegationCertBytes instanceof Uint8Array && delegationCertBytes.length > 0) {
      receiptUnprotected.set(DELEGATION_CERT_LABEL, delegationCertBytes);
      console.log("[resolve-receipt] copied delegation cert from checkpoint", {
        certLen: delegationCertBytes.length,
      });
    } else {
      console.log("[resolve-receipt] no delegation cert in checkpoint");
    }

    // Attach the inclusion proof under 396.
    // Encodes as: {396: {-1: [{1: mmrIndex, 2: [h1, h2, ...]}]}}
    const inclusionProofEntry = new Map<number, unknown>([
      [1, mmrIndex],
      [2, proof],
    ]);
    const verifiableProofs = new Map<number, unknown>([
      [-1, [inclusionProofEntry]],
    ]);
    receiptUnprotected.set(VDS_COSE_RECEIPT_PROOFS_TAG, verifiableProofs);

    const assembled: CoseSign1 = [
      receiptSign1[0],
      receiptUnprotected,
      receiptSign1[2],
      receiptSign1[3],
    ];

    return cborResponse(assembled, 200, CBOR_CONTENT_TYPES.SCITT_RECEIPT);
  } catch (error) {
    console.error("Error resolving receipt:", error);

    return ClientErrors.notFound(
      "Entry receipt not found or error retrieving receipt",
    );
  }
}

interface IndexStoreGetter {
  get(i: bigint): Uint8Array;
}

function unwrapCoseSign1Tag(value: unknown, label: string): unknown {
  if (value && typeof value === "object" && !(value instanceof Map)) {
    const tagged: any = value;
    if (
      Object.prototype.hasOwnProperty.call(tagged, "value") &&
      Object.prototype.hasOwnProperty.call(tagged, "tag")
    ) {
      const tag = tagged.tag;
      if (tag === 18 || tag === "18") {
        console.log("[resolve-receipt] unwrapped tagged COSE_Sign1", {
          label,
          tag,
        });
        return tagged.value;
      }
    }
  }

  return value;
}

function requireCoseSign1(value: unknown, label: string): CoseSign1 {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`${label} is not a COSE_Sign1 array`);
  }

  const [p, u, payload, sig] = value as any[];

  if (!(p instanceof Uint8Array)) {
    throw new Error(`${label} protected header is not bstr`);
  }
  if (!(sig instanceof Uint8Array)) {
    throw new Error(`${label} signature is not bstr`);
  }
  if (!(payload === null || payload instanceof Uint8Array)) {
    throw new Error(`${label} payload is not bstr/null`);
  }

  return [p, u, payload, sig];
}

function toHeaderMap(
  value: Map<number, unknown> | Record<string, unknown>,
): Map<number, unknown> {
  if (value instanceof Map) {
    return value as Map<number, unknown>;
  }

  const out = new Map<number, unknown>();
  if (typeof value !== "object" || value === null) {
    return out;
  }

  for (const [k, v] of Object.entries(value)) {
    const n = Number(k);
    if (Number.isFinite(n) && String(n) === k) {
      out.set(n, v);
    } else {
      // Fall back to string key if it isn't a simple integer.
      out.set(n, v);
    }
  }

  return out;
}

function readStateMMRSize(state: unknown): bigint {
  // MMRState.mmrSize has CBOR key 1.
  if (state instanceof Map) {
    const raw = state.get(1);
    return asBigInt(raw);
  }
  if (typeof state === "object" && state !== null) {
    return asBigInt((state as any)[1] ?? (state as any)["1"]);
  }
  return 0n;
}

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  return 0n;
}

function formatObjectIndex16(index: bigint): string {
  const s = index.toString(10);
  return s.padStart(16, "0");
}

// --- Merklelog v2 massif layout ---

const VALUE_BYTES = 32n;
const RESERVED_HEADER_SLOTS = 7n;
const INDEX_HEADER_BYTES = 32n;
const MAX_MMR_HEIGHT = 64n;

const BLOOM_BITS_PER_ELEMENT_V1 = 10n;
const BLOOM_FILTERS = 4n;
const BLOOM_HEADER_BYTES_V1 = 32n;

const URKLE_FRONTIER_STATE_V1_BYTES = 544n;
const URKLE_LEAF_RECORD_BYTES = 128n;
const URKLE_NODE_RECORD_BYTES = 64n;

function v2OffsetsForMassif(massifHeight: number): {
  peakStackStart: bigint;
  logStart: bigint;
} {
  const fixedHeaderEnd = VALUE_BYTES + VALUE_BYTES * RESERVED_HEADER_SLOTS; // 256
  const trieHeaderEnd = fixedHeaderEnd + INDEX_HEADER_BYTES; // 288

  const leafCount = urkleLeafCountForMassifHeight(massifHeight);
  const indexDataBytes = indexDataBytesV2(leafCount);

  const peakStackStart = trieHeaderEnd + indexDataBytes;
  const logStart = peakStackStart + MAX_MMR_HEIGHT * VALUE_BYTES;

  return { peakStackStart, logStart };
}

function urkleLeafCountForMassifHeight(massifHeight: number): bigint {
  if (!Number.isInteger(massifHeight) || massifHeight <= 0) return 0n;
  return 1n << BigInt(massifHeight - 1);
}

function indexDataBytesV2(leafCount: bigint): bigint {
  if (leafCount <= 0n) return 0n;

  // Bloom bitsets (excluding the 32B header, which lives in the fixed index header region).
  const mBits = BLOOM_BITS_PER_ELEMENT_V1 * leafCount;
  const bitsetBytes = (mBits + 7n) / 8n; // ceil(mBits/8)
  const bloomRegionBytes = BLOOM_HEADER_BYTES_V1 + BLOOM_FILTERS * bitsetBytes;
  const bloomBitsetsBytes = bloomRegionBytes - BLOOM_HEADER_BYTES_V1;

  const leafTableBytes = leafCount * URKLE_LEAF_RECORD_BYTES;
  const nodeStoreBytes = (2n * leafCount - 1n) * URKLE_NODE_RECORD_BYTES;

  return (
    bloomBitsetsBytes +
    URKLE_FRONTIER_STATE_V1_BYTES +
    leafTableBytes +
    nodeStoreBytes
  );
}

function slice32(buf: Uint8Array, offset: bigint, label: string): Uint8Array {
  if (offset < 0n) {
    throw new Error(`negative offset for ${label}`);
  }
  if (
    offset > BigInt(buf.byteLength) ||
    offset + 32n > BigInt(buf.byteLength)
  ) {
    throw new Error(
      `out of range read for ${label}: off=${offset.toString(10)}`,
    );
  }
  const start = Number(offset);
  return buf.slice(start, start + 32);
}

// --- Merklelog v2 massif header parsing ---

interface MassifStartHeader {
  lastId: bigint;
  version: number;
  commitmentEpoch: number;
  massifHeight: number;
  massifIndex: number;
}

function readMassifStart(data: Uint8Array): MassifStartHeader {
  if (data.byteLength < 32) {
    throw new Error("massif data too short");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const lastId = view.getBigUint64(8, false);
  const version = view.getUint16(21, false);
  const commitmentEpoch = view.getUint32(23, false);
  const massifHeight = data[27];
  const massifIndex = view.getUint32(28, false);

  return {
    lastId,
    version,
    commitmentEpoch,
    massifHeight,
    massifIndex,
  };
}

// --- MMR helpers (ported from go-merklelog/mmr) ---

function mmrIndexFromLeafIndex(leafIndex: bigint): bigint {
  // go-merklelog/mmr/mmrindex.go
  let sum = 0n;
  let current = leafIndex;

  while (current > 0n) {
    const h = BigInt(bitLength(current));
    sum += (1n << h) - 1n;
    const half = 1n << (h - 1n);
    current -= half;
  }

  return sum;
}

function massifFirstLeaf(massifHeight: number, massifIndex: bigint): bigint {
  // go-merklelog/massifs/massifstart.go MassifFirstLeaf
  const m = (1n << BigInt(massifHeight)) - 1n;
  const f = (m + 1n) / 2n;
  const leafIndex = f * massifIndex;
  return mmrIndexFromLeafIndex(leafIndex);
}

function leafMinusSpurSum(leafIndex: bigint): bigint {
  // go-merklelog/mmr/spurs.go LeafMinusSpurSum
  let sum = leafIndex;
  let current = leafIndex >> 1n;
  while (current > 0n) {
    sum -= current;
    current >>= 1n;
  }
  return sum;
}

function indexHeight(i: bigint): number {
  // go-merklelog/mmr/indexheight.go IndexHeight -> PosHeight(i+1)
  return posHeight(i + 1n);
}

function posHeight(pos: bigint): number {
  let current = pos;
  while (!allOnes(current)) {
    current = jumpLeftPerfect(current);
  }
  return bitLength(current) - 1;
}

function allOnes(num: bigint): boolean {
  // Equivalent to (num & (num+1)) == 0 for num>0.
  return num > 0n && (num & (num + 1n)) === 0n;
}

function jumpLeftPerfect(pos: bigint): bigint {
  const bl = bitLength(pos);
  if (bl === 0) return pos;
  const msb = 1n << BigInt(bl - 1);
  return pos - (msb - 1n);
}

function bitLength(num: bigint): number {
  if (num === 0n) return 0;
  return num.toString(2).length;
}

function firstMMRSize(mmrIndex: bigint): bigint {
  // go-merklelog/mmr/firstmmrsize.go FirstMMRSize
  let i = mmrIndex;
  let h0 = indexHeight(i);
  let h1 = indexHeight(i + 1n);
  while (h0 < h1) {
    i += 1n;
    h0 = h1;
    h1 = indexHeight(i + 1n);
  }
  return i + 1n;
}

function peaksBitmap(mmrSize: bigint): bigint {
  // go-merklelog/mmr/peaks.go PeaksBitmap
  if (mmrSize === 0n) return 0n;

  let pos = mmrSize;
  let peakSize = (1n << BigInt(bitLength(mmrSize))) - 1n;
  let peakMap = 0n;

  while (peakSize > 0n) {
    peakMap <<= 1n;
    if (pos >= peakSize) {
      pos -= peakSize;
      peakMap |= 1n;
    }
    peakSize >>= 1n;
  }

  return peakMap;
}

function leafIndexFromMMRIndex(mmrIndex: bigint): bigint {
  // go-merklelog/mmr/leafcount.go LeafIndex
  const size = firstMMRSize(mmrIndex);
  const leafCount = peaksBitmap(size);
  return leafCount - 1n;
}

function massifIndexFromMMRIndex(
  massifHeight: number,
  mmrIndex: bigint,
): bigint {
  // go-merklelog/massifs/massifindex.go MassifIndexFromMMRIndex
  const leafIndex = leafIndexFromMMRIndex(mmrIndex);
  const massifMaxLeaves = 1n << BigInt(massifHeight - 1);
  return leafIndex / massifMaxLeaves;
}

function peaks(mmrIndex: bigint): bigint[] {
  // go-merklelog/mmr/peaks.go Peaks
  let mmrSize = mmrIndex + 1n;

  // catch invalid range, where siblings exist but no parent exists
  if (posHeight(mmrSize + 1n) > posHeight(mmrSize)) {
    return [];
  }

  let peak = 0n;
  const out: bigint[] = [];

  while (mmrSize !== 0n) {
    const peakSize = topPeak(mmrSize - 1n) + 1n;
    peak = peak + peakSize;
    out.push(peak - 1n);
    mmrSize -= peakSize;
  }

  return out;
}

function topPeak(i: bigint): bigint {
  // go-merklelog/mmr/peaks.go TopPeak
  const bl = bitLength(i + 2n);
  return (1n << BigInt(bl - 1)) - 2n;
}

function peakStackMapForMassif(
  massifHeight: number,
  firstIndex: bigint,
): Map<bigint, number> {
  // go-merklelog/massifs/peakstack.go PeakStackMap
  const map = new Map<bigint, number>();
  const iPeaks = peaks(firstIndex);

  for (let i = 0; i < iPeaks.length; i++) {
    const ip = iPeaks[i];
    if (indexHeight(ip) < massifHeight - 1) {
      continue;
    }
    map.set(ip, i);
  }

  return map;
}

function inclusionProof(
  store: IndexStoreGetter,
  mmrLastIndex: bigint,
  i: bigint,
): Uint8Array[] {
  // go-merklelog/mmr/proof.go InclusionProof
  if (i > mmrLastIndex) {
    throw new Error("index out of range");
  }

  let g = BigInt(indexHeight(i));
  const proof: Uint8Array[] = [];

  // iSibling is guaranteed to break the loop
  while (true) {
    const siblingOffset = 2n << g;

    let iSibling: bigint;
    if (BigInt(indexHeight(i + 1n)) > g) {
      // right sibling
      iSibling = i - siblingOffset + 1n;
      i += 1n;
    } else {
      // left sibling
      iSibling = i + siblingOffset - 1n;
      i += siblingOffset;
    }

    if (iSibling > mmrLastIndex) {
      return proof;
    }

    proof.push(store.get(iSibling));
    g += 1n;
  }
}

function peakIndexForLeafProof(mmrSize: bigint, proofLen: number): number {
  // Equivalent to: PeakIndex(LeafCount(mmrSize), proofLen)
  const leafCount = peaksBitmap(mmrSize);
  return peakIndex(leafCount, proofLen);
}

function peakIndex(leafCount: bigint, d: number): number {
  // go-merklelog/mmr/peaks.go PeakIndex
  const peaksMask = (1n << BigInt(d + 1)) - 1n;
  const n = popcount64(leafCount & peaksMask);
  const a = popcount64(leafCount);
  return a - n;
}

function popcount64(x: bigint): number {
  let count = 0;
  let v = x;
  while (v > 0n) {
    if ((v & 1n) === 1n) count += 1;
    v >>= 1n;
  }
  return count;
}

/**
 * Build a grant/entry receipt for the given log and MMR index (for grant receipt verification).
 * Fetches checkpoint and massif from R2, builds inclusion proof, attaches to peak receipt.
 * Returns CBOR-encoded receipt bytes or null if checkpoint/massif missing or on error.
 */
export async function buildReceiptForEntry(
  logId: string,
  massifHeight: number,
  mmrIndex: bigint,
  mmrs: R2Bucket,
): Promise<Uint8Array | null> {
  try {
    const massifIndex = massifIndexFromMMRIndex(massifHeight, mmrIndex);
    const objectIndex = formatObjectIndex16(massifIndex);
    const checkpointKey = `v2/merklelog/checkpoints/${massifHeight}/${logId}/${objectIndex}.sth`;
    const massifKey = `v2/merklelog/massifs/${massifHeight}/${logId}/${objectIndex}.log`;

    const checkpointObject = await mmrs.get(checkpointKey);
    if (!checkpointObject) return null;

    const checkpointBytes = new Uint8Array(
      await checkpointObject.arrayBuffer(),
    );
    const checkpointDecoded = decodeCbor(checkpointBytes) as unknown;
    const checkpoint = unwrapCoseSign1Tag(checkpointDecoded, "checkpoint");
    const checkpointSign1 = requireCoseSign1(checkpoint, "checkpoint");

    const checkpointUnprotected = toHeaderMap(checkpointSign1[1]);
    const peakReceiptsRaw = checkpointUnprotected.get(SEAL_PEAK_RECEIPTS_LABEL);
    if (!Array.isArray(peakReceiptsRaw)) return null;
    const peakReceipts = peakReceiptsRaw as unknown[];

    const checkpointPayload = checkpointSign1[2];
    if (!(checkpointPayload instanceof Uint8Array)) return null;
    const state = decodeCbor(checkpointPayload) as unknown;
    const mmrSize = readStateMMRSize(state);
    if (mmrSize <= 0n) return null;
    const mmrLastIndex = mmrSize - 1n;
    if (mmrIndex > mmrLastIndex) return null;

    const massifObject = await mmrs.get(massifKey);
    if (!massifObject) return null;

    const massifBytes = new Uint8Array(await massifObject.arrayBuffer());
    const massifHeader = readMassifStart(massifBytes);
    if (massifHeader.massifHeight !== massifHeight) return null;
    if (BigInt(massifHeader.massifIndex) !== massifIndex) return null;

    const firstIndex = massifFirstLeaf(massifHeader.massifHeight, massifIndex);
    const peakStackMap = peakStackMapForMassif(massifHeight, firstIndex);
    const { peakStackStart, logStart } = v2OffsetsForMassif(massifHeight);
    const store: IndexStoreGetter = {
      get: (i) => {
        if (i >= firstIndex) {
          const localIndex = i - firstIndex;
          const off = logStart + localIndex * 32n;
          return slice32(massifBytes, off, "log-data");
        }
        const peakIdx = peakStackMap.get(i);
        if (peakIdx === undefined) {
          throw new Error(
            `missing ancestor peak for mmr index ${i.toString(10)}`,
          );
        }
        const off = peakStackStart + BigInt(peakIdx) * 32n;
        return slice32(massifBytes, off, "peak-stack");
      },
    };

    const proof = inclusionProof(store, mmrLastIndex, mmrIndex);
    const peakIndex = peakIndexForLeafProof(mmrSize, proof.length);
    const receiptBytes = peakReceipts[peakIndex];
    if (!(receiptBytes instanceof Uint8Array)) return null;

    const receiptDecoded = decodeCbor(receiptBytes) as unknown;
    const receipt = unwrapCoseSign1Tag(receiptDecoded, "peak receipt");
    const receiptSign1 = requireCoseSign1(receipt, "peak receipt");
    const receiptUnprotected = toHeaderMap(receiptSign1[1]);
    const inclusionProofEntry = new Map<number, unknown>([
      [1, mmrIndex],
      [2, proof],
    ]);
    const verifiableProofs = new Map<number, unknown>([
      [-1, [inclusionProofEntry]],
    ]);
    receiptUnprotected.set(VDS_COSE_RECEIPT_PROOFS_TAG, verifiableProofs);
    const assembled: CoseSign1 = [
      receiptSign1[0],
      receiptUnprotected,
      receiptSign1[2],
      receiptSign1[3],
    ];
    return encodeCbor(assembled) as Uint8Array;
  } catch {
    return null;
  }
}
