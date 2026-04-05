/**
 * Grant receipt verification: parse COSE receipt, verify MMR inclusion, optionally verify signature.
 * Uses @canopy/merklelog verifyInclusion and grant leaf commitment.
 *
 * Receipt format: COSE Sign1 with payload = peak hash (32 bytes) or detached
 * (nil); header 396 = inclusion proof. Detached payloads match MMRIVER peak
 * receipts from storage (payload cleared after signing).
 * Proof structure (MMRIVER): { -1: [ { 1: mmrIndex, 2: path (array of 32-byte hashes) } ] }.
 */

import { decode as decodeCbor } from "cbor-x";
import { verifyCoseSign1 } from "@canopy/encoding";
import {
  calculateRoot,
  verifyInclusion,
  type Hasher,
  type Proof,
} from "@canopy/merklelog";
import type { Grant } from "./grant.js";
import { grantCommitmentHashFromGrant } from "./grant-commitment.js";
import { univocityLeafHash } from "./leaf-commitment.js";

/**
 * Hasher for Workers: uses crypto.subtle.digest (no sync crypto in Workers).
 */
class SubtleHasher implements Hasher {
  private chunks: Uint8Array[] = [];

  reset(): void {
    this.chunks = [];
  }

  update(data: Uint8Array): void {
    this.chunks.push(data);
  }

  async digest(): Promise<Uint8Array> {
    const totalLength = this.chunks.reduce((s, c) => s + c.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of this.chunks) {
      combined.set(c, offset);
      offset += c.length;
    }
    const h = await crypto.subtle.digest("SHA-256", combined);
    return new Uint8Array(h);
  }
}

const VDS_COSE_RECEIPT_PROOFS_TAG = 396;

type CoseSign1 = [
  protectedHeader: Uint8Array,
  unprotectedHeader: Map<number, unknown> | Record<string, unknown>,
  payload: Uint8Array | null,
  signature: Uint8Array,
];

function unwrapCoseSign1Tag(value: unknown): unknown {
  if (value && typeof value === "object" && !(value instanceof Map)) {
    const tagged = value as { tag?: number; value?: unknown };
    if (
      Object.prototype.hasOwnProperty.call(tagged, "value") &&
      tagged.tag === 18
    ) {
      return tagged.value;
    }
  }
  return value;
}

function requireCoseSign1(value: unknown): CoseSign1 {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error("Receipt is not a COSE Sign1 array");
  }
  const [p, u, payload, sig] = value as unknown[];
  if (!(p instanceof Uint8Array) || !(sig instanceof Uint8Array)) {
    throw new Error("Invalid COSE Sign1 structure");
  }
  if (!(payload === null || payload instanceof Uint8Array)) {
    throw new Error("Invalid COSE Sign1 payload");
  }
  return [
    p,
    u as Map<number, unknown> | Record<string, unknown>,
    payload,
    sig,
  ] as CoseSign1;
}

function toHeaderMap(
  value: Map<number, unknown> | Record<string, unknown>,
): Map<number, unknown> {
  if (value instanceof Map) return value as Map<number, unknown>;
  const out = new Map<number, unknown>();
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      const n = Number(k);
      if (Number.isFinite(n)) out.set(n, v);
    }
  }
  return out;
}

/**
 * Parse receipt bytes (COSE Sign1, optionally CBOR tag 18 wrapped) and extract
 * optional explicit peak (from payload) and proof.
 */
export function parseReceipt(receiptBytes: Uint8Array): {
  explicitPeak: Uint8Array | null;
  proof: Proof;
  coseSign1: CoseSign1;
} {
  const decoded = decodeCbor(receiptBytes) as unknown;
  const unwrapped = unwrapCoseSign1Tag(decoded);
  const coseSign1 = requireCoseSign1(unwrapped);

  const payload = coseSign1[2];
  let explicitPeak: Uint8Array | null = null;
  if (payload instanceof Uint8Array) {
    if (payload.length !== 32) {
      throw new Error("Receipt payload must be 32 bytes (peak hash)");
    }
    explicitPeak = payload;
  } else if (payload !== null && payload !== undefined) {
    throw new Error(
      "Receipt payload must be nil (detached) or 32-byte peak hash",
    );
  }

  const unprotected = toHeaderMap(coseSign1[1]);
  const proofsRaw = unprotected.get(VDS_COSE_RECEIPT_PROOFS_TAG);
  if (!proofsRaw || typeof proofsRaw !== "object") {
    throw new Error("Receipt missing header 396 (inclusion proof)");
  }
  const proofsMap = proofsRaw as Map<number, unknown> | Record<number, unknown>;
  const proofList = (
    proofsMap instanceof Map
      ? proofsMap.get(-1)
      : (proofsMap as Record<number, unknown>)[-1]
  ) as unknown[] | undefined;
  if (!Array.isArray(proofList) || proofList.length === 0) {
    throw new Error("Receipt proof -1 must be non-empty array");
  }
  const entry = proofList[0] as Record<number, unknown> | Map<number, unknown>;
  const mmrIndexRaw =
    entry instanceof Map ? entry.get(1) : (entry as Record<number, unknown>)[1];
  const pathRaw =
    entry instanceof Map ? entry.get(2) : (entry as Record<number, unknown>)[2];
  if (mmrIndexRaw === undefined || !Array.isArray(pathRaw)) {
    throw new Error("Proof entry must have 1: mmrIndex, 2: path");
  }
  const mmrIndex =
    typeof mmrIndexRaw === "bigint" ? mmrIndexRaw : BigInt(Number(mmrIndexRaw));
  const path = pathRaw.map((h: unknown) => {
    if (!(h instanceof Uint8Array) || h.length !== 32) {
      throw new Error("Proof path elements must be 32-byte hashes");
    }
    return h;
  });

  return {
    explicitPeak,
    proof: { path, mmrIndex },
    coseSign1,
  };
}

/**
 * Verify the inclusion proof in the receipt: leaf (grant) is in the MMR with the signed root.
 * Uses @canopy/merklelog verifyInclusion (single async implementation).
 */
export async function verifyReceiptInclusion(
  grant: Grant,
  idtimestampBytes: Uint8Array,
  receiptBytes: Uint8Array,
): Promise<boolean> {
  const inner = await grantCommitmentHashFromGrant(grant);
  if (!idtimestampBytes || idtimestampBytes.length < 8) {
    throw new Error("idtimestamp required for receipt verification (8 bytes)");
  }
  const idtimestamp =
    idtimestampBytes.length === 8
      ? new DataView(
          idtimestampBytes.buffer,
          idtimestampBytes.byteOffset,
          8,
        ).getBigUint64(0, false)
      : new DataView(
          idtimestampBytes.buffer,
          idtimestampBytes.byteOffset + idtimestampBytes.length - 8,
          8,
        ).getBigUint64(0, false);
  const leafHash = await univocityLeafHash(idtimestamp, inner);

  const { explicitPeak, proof } = parseReceipt(receiptBytes);
  const hasher = new SubtleHasher();
  const leafIdx =
    proof.leafIndex !== undefined ? proof.leafIndex : proof.mmrIndex!;
  const peak =
    explicitPeak !== null
      ? explicitPeak
      : await calculateRoot(hasher, leafHash, proof, leafIdx);
  return verifyInclusion(hasher, leafHash, proof, peak);
}

export interface ReceiptInclusionVerifyOptions {
  /** Full receipt COSE Sign1 CBOR bytes (transparent statement header 396). */
  receiptCoseBytes: Uint8Array;
  /** Log-operator public key (Custodian SPKI PEM → importKey) for receipt Sign1. */
  receiptVerifyKey: CryptoKey;
}

/**
 * Verify inclusion using already-parsed root and proof (e.g. from GrantResult, Plan 0005).
 * When `receiptVerification` is set: verifies receipt COSE Sign1 first, then MMR inclusion.
 */
export async function verifyReceiptInclusionFromParsed(
  grant: Grant,
  idtimestampBytes: Uint8Array,
  explicitPeak: Uint8Array | null,
  proof: Proof,
  receiptVerification?: ReceiptInclusionVerifyOptions,
): Promise<boolean> {
  if (receiptVerification) {
    const sigOk = await verifyCoseSign1(
      receiptVerification.receiptCoseBytes,
      receiptVerification.receiptVerifyKey,
      { logFailures: true, logPrefix: "grant-receipt-cose" },
    );
    if (!sigOk) return false;
  }

  const inner = await grantCommitmentHashFromGrant(grant);
  if (!idtimestampBytes || idtimestampBytes.length < 8) {
    throw new Error("idtimestamp required for receipt verification (8 bytes)");
  }
  const idtimestamp =
    idtimestampBytes.length === 8
      ? new DataView(
          idtimestampBytes.buffer,
          idtimestampBytes.byteOffset,
          8,
        ).getBigUint64(0, false)
      : new DataView(
          idtimestampBytes.buffer,
          idtimestampBytes.byteOffset + idtimestampBytes.length - 8,
          8,
        ).getBigUint64(0, false);
  const leafHash = await univocityLeafHash(idtimestamp, inner);
  const hasher = new SubtleHasher();
  const leafIdx =
    proof.leafIndex !== undefined ? proof.leafIndex : proof.mmrIndex!;
  const peak =
    explicitPeak !== null
      ? explicitPeak
      : await calculateRoot(hasher, leafHash, proof, leafIdx);
  return verifyInclusion(hasher, leafHash, proof, peak);
}

/**
 * Full grant receipt verification: inclusion proof and optionally COSE signature.
 * Returns true if inclusion verifies; if verifySignature is provided, also verifies the receipt's COSE Sign1 signature.
 */
export async function verifyGrantReceipt(
  grant: Grant,
  idtimestampBytes: Uint8Array,
  receiptBytes: Uint8Array,
  options?: {
    verifySignature?: (receiptCoseSign1: CoseSign1) => Promise<boolean>;
  },
): Promise<boolean> {
  const { coseSign1 } = parseReceipt(receiptBytes);
  const inclusionOk = await verifyReceiptInclusion(
    grant,
    idtimestampBytes,
    receiptBytes,
  );
  if (!inclusionOk) return false;
  if (options?.verifySignature) {
    return options.verifySignature(coseSign1);
  }
  return true;
}
