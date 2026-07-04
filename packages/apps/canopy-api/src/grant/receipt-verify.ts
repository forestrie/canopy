/**
 * Grant receipt verification: parse COSE receipt, verify MMR inclusion, optionally verify signature.
 * Parse and offline verify live in @forestrie/receipt-verify; this module keeps Workers
 * runtime paths (trust-root resolver, delegation verify keys).
 */

import { verifyCoseSign1WithParsedKey } from "@canopy/encoding";
import { parseReceipt } from "@forestrie/receipt-verify";
import type { RootVerifyKey } from "../env/trust-root-client.js";
import { es256ReceiptVerifyKeys } from "../env/decode-trust-root-cbor.js";
import {
  calculateRoot,
  verifyInclusion,
  type Hasher,
  type Proof,
} from "@canopy/merklelog";
import type { Grant } from "./grant.js";
import { grantCommitmentHashFromGrant } from "./grant-commitment.js";
import { univocityLeafHash } from "./leaf-commitment.js";

export { parseReceipt } from "@forestrie/receipt-verify";

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

type CoseSign1 = ReturnType<typeof parseReceipt>["coseSign1"];

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
  /**
   * Pre-resolved verify key candidates (delegated ES256 key first, then trust root).
   * KS256 root keys are used for delegation cert verify only and are skipped here.
   */
  receiptVerifyKeys: RootVerifyKey[];
}

/** Outcome of {@link verifyReceiptInclusionFromParsed} when receipt verification is enabled. */
export type ReceiptInclusionVerifyOutcome =
  | "ok"
  | "no-verify-keys"
  | "signature-failed"
  /** Signature failed but MMR inclusion would succeed (trust-root / detached peak). */
  | "signature-failed-inclusion-ok"
  | "inclusion-failed";

/**
 * Verify inclusion using already-parsed root and proof (e.g. from GrantResult, Plan 0005).
 * When `receiptVerification` is set: resolves the delegation chain, computes the
 * peak from the inclusion proof, then verifies the receipt COSE Sign1 signature
 * using the peak as detachedPayload (peak receipts have nil payload in storage
 * but the signature was computed over the 32-byte peak hash).
 */
export async function verifyReceiptInclusionFromParsed(
  grant: Grant,
  idtimestampBytes: Uint8Array,
  explicitPeak: Uint8Array | null,
  proof: Proof,
  receiptVerification?: ReceiptInclusionVerifyOptions,
): Promise<ReceiptInclusionVerifyOutcome> {
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

  if (receiptVerification) {
    const verifyKeys = es256ReceiptVerifyKeys(
      receiptVerification.receiptVerifyKeys,
    );
    if (!verifyKeys.length) {
      console.warn("grant-receipt-verify: no verify keys supplied");
      return "no-verify-keys";
    }

    let sigOk = false;
    for (const candidateKey of verifyKeys) {
      sigOk = await verifyCoseSign1WithParsedKey(
        receiptVerification.receiptCoseBytes,
        candidateKey,
        { logPrefix: "grant-receipt-cose", detachedPayload: peak },
      );
      if (sigOk) break;
      if (explicitPeak !== null) {
        sigOk = await verifyCoseSign1WithParsedKey(
          receiptVerification.receiptCoseBytes,
          candidateKey,
          { logPrefix: "grant-receipt-cose" },
        );
        if (sigOk) break;
      }
    }
    if (!sigOk) {
      console.warn("grant-receipt-verify: receipt signature failed");
      if (explicitPeak !== null) {
        const inclusionOk = await verifyInclusion(
          hasher,
          leafHash,
          proof,
          explicitPeak,
        );
        return inclusionOk
          ? "signature-failed-inclusion-ok"
          : "signature-failed";
      }
      return "signature-failed";
    }
  }

  const inclusionOk = await verifyInclusion(hasher, leafHash, proof, peak);
  return inclusionOk ? "ok" : "inclusion-failed";
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
