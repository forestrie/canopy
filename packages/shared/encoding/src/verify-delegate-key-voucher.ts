/**
 * Verify a custodian-signed delegate-key voucher (FOR-390 phase G/H).
 *
 * A voucher is an untagged COSE_Sign1 (ES256) signed by the custodian's
 * registrar voucher key, attesting that a standing delegate public key was
 * derived from the KMS seed for a given (sealerId, epoch). The coordinator
 * verifies it at registration ingest, and the kit verifies it against the
 * pinned registrar key before `signAdvanceDelegation` binds the key — so a
 * compromised coordinator cannot induce a root holder to delegate to a key the
 * sealer does not control (ADR-0050 §"Trust model and genesis topology").
 *
 * This mirrors the Go builder/verifier in arbor
 * `services/custodian/src/voucher.go`. The voucher uses the embedded-claims
 * profile: the payload is the canonical int-keyed CBOR map
 * `{1: sealerId (tstr), 2: epoch (uint), 3: delegateKeyCoseCbor (bstr)}`, so
 * verification is a signature check plus a field-compare — no cross-impl
 * re-canonicalisation of the voucher envelope is required.
 */

import { decodeCborDeterministic } from "./decode-cbor-deterministic.js";
import {
  decodeCoseSign1,
  verifyCoseSign1WithParsedKey,
  type ParsedEcPublicKey,
  type VerifyCoseSign1Options,
} from "./verify-cose-sign1.js";

/** The tuple a voucher attests, in the form the caller expects to see. */
export interface DelegateKeyVoucherClaims {
  /** Sealer identity the delegate key belongs to. */
  sealerId: string;
  /** Operator-bumped rotation epoch (>= 1). */
  epoch: number;
  /**
   * Canonical COSE_Key CBOR bytes of the delegate public key — byte-identical
   * to the registered `delegate_keys.public_key` and to the certificate's
   * `delegated_pubkey_hash` preimage.
   */
  publicKey: Uint8Array;
}

/** Result of {@link verifyDelegateKeyVoucher}; `reason` names the failing check. */
export type VerifyDelegateKeyVoucherResult =
  | { ok: true }
  | { ok: false; reason: string };

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Verify a voucher's signature against the pinned registrar key AND that its
 * claims equal `expect`. Both must hold. Any malformed input fails closed.
 *
 * @param voucherBytes - untagged COSE_Sign1 voucher CBOR
 * @param pinnedRegistrarKey - the pinned registrar public key (P-256 coords)
 * @param expect - the claims the caller requires the voucher to attest
 * @param opts - optional failure logging (forwarded to the COSE verifier)
 */
export async function verifyDelegateKeyVoucher(
  voucherBytes: Uint8Array,
  pinnedRegistrarKey: ParsedEcPublicKey,
  expect: DelegateKeyVoucherClaims,
  opts?: VerifyCoseSign1Options,
): Promise<VerifyDelegateKeyVoucherResult> {
  const sigOk = await verifyCoseSign1WithParsedKey(
    voucherBytes,
    pinnedRegistrarKey,
    opts,
  );
  if (!sigOk) return { ok: false, reason: "signature" };

  const decoded = decodeCoseSign1(voucherBytes);
  if (!decoded) return { ok: false, reason: "decode" };

  let claims: unknown;
  try {
    claims = decodeCborDeterministic(decoded.payloadBstr);
  } catch {
    return { ok: false, reason: "claims_decode" };
  }
  if (!(claims instanceof Map)) return { ok: false, reason: "claims_shape" };

  const sealerId = claims.get(1);
  const epochRaw = claims.get(2);
  const keyBytes = claims.get(3);
  const epoch = typeof epochRaw === "bigint" ? Number(epochRaw) : epochRaw;

  if (typeof sealerId !== "string" || sealerId !== expect.sealerId) {
    return { ok: false, reason: "sealerId" };
  }
  if (typeof epoch !== "number" || epoch !== expect.epoch) {
    return { ok: false, reason: "epoch" };
  }
  if (!(keyBytes instanceof Uint8Array) || !bytesEqual(keyBytes, expect.publicKey)) {
    return { ok: false, reason: "publicKey" };
  }
  return { ok: true };
}

/**
 * Parse a pinned registrar key from base64 `x||y` (64 bytes) into the parsed
 * P-256 coordinates {@link verifyDelegateKeyVoucher} expects. Returns null on a
 * malformed value.
 *
 * @param raw - 64-byte uncompressed `x||y` (no 0x04 prefix)
 */
export function parseRegistrarKeyXY(raw: Uint8Array): ParsedEcPublicKey | null {
  if (raw.length !== 64) return null;
  return { x: raw.slice(0, 32), y: raw.slice(32, 64), curve: "P-256" };
}
