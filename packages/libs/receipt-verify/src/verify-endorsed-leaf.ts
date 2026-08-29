/**
 * The single offline rung for a passkey-rooted log (devdocs ADR-0065 §5,
 * plan-2608-14 1.2). From public artifacts only — the log root (on-chain
 * `logRootKey` == the grant's `grantData`), the exact registered leaf bytes,
 * the receipt and its idtimestamp — reconstruct:
 *
 *   root → endorsement (-65801 inside the leaf; -65800 verify under the
 *   root, UV per the grant flag, window from the payload)
 *     → session key
 *       → leaf: kid == session x, ES256 signature under the session key
 *         → receipt: leaf bytes hash to the receipted index (inclusion),
 *           receipted idtimestamp ∈ [notBefore, notAfter]
 *
 * There is exactly one route and no fallback: a leaf without an endorsement
 * is not verified under the root here (that is the plain
 * `verifyReceiptOffline*` path for root-signed logs), and the ADR-0064
 * export-fed rung (`resolveEndorsedSessionKey` over a `/receipts` export)
 * is gone — the endorsement an auditor needs is inside the committed leaf.
 *
 * Tampering closes both ways (ADR-0065 §5): editing the endorsement changes
 * `contentHash`, so inclusion fails; substituting a different valid
 * endorsement changes the session key, so the leaf signature fails.
 */

import {
  COSE_LABEL_SESSION_KEY_ENDORSEMENT,
  coseUnprotectedToMap,
  decodeCborDeterministic,
  decodeCoseSign1,
  verifyCoseSign1WithParsedKey,
} from "@forestrie/encoding";
import { importEs256PublicKeyFromGrantDataXy64 } from "./decode-trust-root-cbor.js";
import { idtimestampToUnixMs } from "./resolve-delegated-verify-key.js";
import {
  checkEndorsementWindow,
  verifySessionKeyEndorsement,
  type SessionKeyEndorsementFailureReason,
} from "./session-key-endorsement.js";
import { verifyReceiptOfflineWithKeys } from "./verify-grant-receipt-offline.js";

/** COSE header label for key id (kid). */
const COSE_KID = 4;

export interface VerifyEndorsedLeafInput {
  /**
   * The log root as raw P-256 x‖y (64 bytes): the grant's `grantData`, the
   * value univocity binds as `logRootKey`. The endorsement's trust anchor;
   * its kid is pinned to this x.
   */
  rootPublicKeyXY: Uint8Array;
  /** The EXACT registered leaf bytes (COSE Sign1 carrying -65801). */
  statementCbor: Uint8Array;
  /** The receipt over that leaf. */
  receiptCbor: Uint8Array;
  /** The receipted idtimestamp (8 bytes, big-endian). */
  idtimestampBe8: Uint8Array;
  /**
   * Receipt trust anchors (the sealer or, for a delegated seal, the
   * delegation-cert issuer — for a user log that is the root itself, which
   * signs the sealing delegation with a passkey gesture). Defaults to the
   * root. See `verifyReceiptOfflineWithKeys` for the trust model.
   */
  trustKeys?: CryptoKey[];
}

export interface VerifyEndorsedLeafOptions {
  /**
   * The grant's `GF_REQUIRES_USER_VERIFICATION` (ADR-0063 §4): when set the
   * endorsement's assertion must carry UV. User presence is always required.
   */
  requireUserVerification?: boolean;
  /** Emit JSON warning lines on failure paths (no secrets). */
  logFailures?: boolean;
  logPrefix?: string;
}

export type VerifyEndorsedLeafStage =
  | "endorsement"
  | "leaf"
  | "window"
  | "receipt";

export type VerifyEndorsedLeafResult =
  | {
      ok: true;
      /** The endorsed session public key, raw x‖y (64 bytes). */
      sessionPublicKeyXY: Uint8Array;
      /** The endorsement window, unix ms inclusive. */
      notBefore: number;
      notAfter: number;
      /** The receipted idtimestamp's time component, unix ms. */
      leafIdtimestampMs: number;
    }
  | { ok: false; stage: VerifyEndorsedLeafStage; reason: string };

/** ADR-0065 §4 reason vocabulary, shared with canopy admission. */
export type EndorsementAdmissionReason =
  | "endorsement_missing"
  | "endorsement_invalid"
  | "endorsement_root_mismatch"
  | "endorsement_uv_required"
  | "endorsement_expired"
  | "endorsement_not_yet_valid";

/**
 * Fold the endorsement verifier's fine-grained reasons into the ADR-0065 §4
 * admission vocabulary. `signature_invalid` under a coordinate anchor means
 * "a well-formed endorsement that does not chain to THIS root" — the
 * `endorsement_root_mismatch` case; a malformed window is
 * `endorsement_expired` (§4: "window, both directions, and malformed
 * windows" — no instant is inside it); everything else structural is
 * `endorsement_invalid`.
 */
export function endorsementAdmissionReason(
  reason: SessionKeyEndorsementFailureReason,
): EndorsementAdmissionReason {
  switch (reason) {
    case "kid_mismatch":
    case "signature_invalid":
      return "endorsement_root_mismatch";
    case "uv_required":
      return "endorsement_uv_required";
    case "window_invalid":
      return "endorsement_expired";
    default:
      return "endorsement_invalid";
  }
}

/**
 * Read the endorsement bytes from a leaf's unprotected header.
 * `missing` when there is no -65801 entry; `invalid` when the entry is not
 * a byte string (present-but-unusable is never "absent").
 */
export function extractLeafEndorsement(
  statementCbor: Uint8Array,
):
  | { kind: "ok"; endorsement: Uint8Array; kid: Uint8Array | null }
  | { kind: "missing" }
  | { kind: "invalid" } {
  const decoded = decodeCoseSign1(statementCbor);
  if (!decoded) return { kind: "invalid" };
  const entry = coseUnprotectedToMap(decoded.unprotected).get(
    COSE_LABEL_SESSION_KEY_ENDORSEMENT,
  );
  if (entry === undefined) return { kind: "missing" };
  if (!(entry instanceof Uint8Array) || entry.length === 0) {
    return { kind: "invalid" };
  }
  let kid: Uint8Array | null = null;
  try {
    const protectedMap = decodeCborDeterministic(decoded.protectedBstr);
    const raw =
      protectedMap instanceof Map
        ? protectedMap.get(COSE_KID)
        : (protectedMap as Record<number, unknown>)?.[COSE_KID];
    if (raw instanceof Uint8Array) kid = raw;
  } catch {
    kid = null;
  }
  return { kind: "ok", endorsement: entry, kid };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

function readIdtimestampBe8(bytes: Uint8Array): bigint {
  if (!bytes || bytes.length < 8) {
    throw new Error("idtimestamp required (8 bytes)");
  }
  const view =
    bytes.length === 8
      ? new DataView(bytes.buffer, bytes.byteOffset, 8)
      : new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 8, 8);
  return view.getBigUint64(0, false);
}

/**
 * Verify an endorsed leaf and its receipt from public artifacts only.
 * Pure over bytes; no network (rules-of-the-road C1).
 */
export async function verifyEndorsedLeaf(
  input: VerifyEndorsedLeafInput,
  opts?: VerifyEndorsedLeafOptions,
): Promise<VerifyEndorsedLeafResult> {
  if (input.rootPublicKeyXY.length !== 64) {
    return { ok: false, stage: "endorsement", reason: "root_invalid" };
  }
  const logPrefix = opts?.logPrefix ?? "verify-endorsed-leaf";

  // 1. The endorsement, from the leaf itself.
  const extracted = extractLeafEndorsement(input.statementCbor);
  if (extracted.kind === "missing") {
    return { ok: false, stage: "endorsement", reason: "endorsement_missing" };
  }
  if (extracted.kind === "invalid") {
    return { ok: false, stage: "endorsement", reason: "endorsement_invalid" };
  }

  // 2. Under the root (kid pinned to root x by the coordinate anchor).
  const endorsed = await verifySessionKeyEndorsement(
    extracted.endorsement,
    {
      x: input.rootPublicKeyXY.subarray(0, 32),
      y: input.rootPublicKeyXY.subarray(32, 64),
      curve: "P-256",
    },
    {
      requireUserVerification: opts?.requireUserVerification,
      logFailures: opts?.logFailures,
      logPrefix,
    },
  );
  if (!endorsed.ok) {
    return {
      ok: false,
      stage: "endorsement",
      reason: endorsementAdmissionReason(endorsed.reason),
    };
  }

  // 3. The leaf: kid == session x, signature under the session key. The
  // shared verify branch rejects a -65800 entry on a plain-ES256 leaf.
  const sessionX = endorsed.sessionPublicKeyXY.subarray(0, 32);
  if (!extracted.kid || !bytesEqual(extracted.kid, sessionX)) {
    return { ok: false, stage: "leaf", reason: "signer_mismatch" };
  }
  const leafOk = await verifyCoseSign1WithParsedKey(
    input.statementCbor,
    endorsed.sessionKey,
    { logFailures: opts?.logFailures, logPrefix: `${logPrefix}:leaf` },
  );
  if (!leafOk) {
    return { ok: false, stage: "leaf", reason: "leaf_signature_invalid" };
  }

  // 4. The window, against the receipted idtimestamp (never wall-clock —
  // a valid receipt verifies forever). Exact: no skew.
  let idtimestamp: bigint;
  try {
    idtimestamp = readIdtimestampBe8(input.idtimestampBe8);
  } catch {
    return { ok: false, stage: "window", reason: "idtimestamp_invalid" };
  }
  const leafIdtimestampMs = idtimestampToUnixMs(idtimestamp);
  const window = checkEndorsementWindow(endorsed, leafIdtimestampMs);
  if (!window.ok) {
    return { ok: false, stage: "window", reason: window.reason };
  }

  // 5. Inclusion of the EXACT leaf bytes (the endorsement is inside them).
  let trustKeys = input.trustKeys;
  if (!trustKeys) {
    try {
      trustKeys = [
        await importEs256PublicKeyFromGrantDataXy64(input.rootPublicKeyXY),
      ];
    } catch {
      return { ok: false, stage: "receipt", reason: "root_invalid" };
    }
  }
  const receipt = await verifyReceiptOfflineWithKeys({
    receiptCbor: input.receiptCbor,
    payload: input.statementCbor,
    idtimestampBe8: input.idtimestampBe8,
    trustKeys,
  });
  if (!receipt.ok) {
    return {
      ok: false,
      stage: "receipt",
      reason: receipt.reason ?? "receipt_invalid",
    };
  }

  return {
    ok: true,
    sessionPublicKeyXY: endorsed.sessionPublicKeyXY,
    notBefore: endorsed.notBefore,
    notAfter: endorsed.notAfter,
    leafIdtimestampMs,
  };
}
