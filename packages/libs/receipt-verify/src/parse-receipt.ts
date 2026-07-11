import { decode as decodeCbor } from "cbor-x";
import type { Proof } from "@canopy/merklelog";

const VDS_COSE_RECEIPT_PROOFS_TAG = 396;

export type CoseSign1 = [
  protectedHeader: Uint8Array,
  unprotectedHeader: Map<number, unknown> | Record<string, unknown>,
  payload: Uint8Array | null,
  signature: Uint8Array,
];

export function unwrapCoseSign1Tag(value: unknown): unknown {
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

export function requireCoseSign1(value: unknown): CoseSign1 {
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

export function toHeaderMap(
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

export function parseReceipt(receiptBytes: Uint8Array): {
  explicitPeak: Uint8Array | null;
  proof: Proof;
  receiptCbor: Uint8Array;
  coseSign1: CoseSign1;
} {
  const decoded = decodeCbor(receiptBytes) as unknown;
  const unwrapped = unwrapCoseSign1Tag(decoded);
  requireCoseSign1(unwrapped);

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
    receiptCbor: receiptBytes,
    coseSign1,
  };
}
