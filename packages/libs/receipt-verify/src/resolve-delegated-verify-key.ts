/**
 * Offline delegation-chain resolution (FOR-297). When a checkpoint/receipt was
 * signed by a DELEGATED key rather than the log's root key, the delegation
 * certificate travels in the receipt's unprotected header at label 1000
 * (sealer-embedded). This module verifies that certificate under the genesis
 * trust root and returns the delegated public key as an additional verify
 * candidate — the offline port of canopy-api's `resolveReceiptVerifyKey`.
 *
 * ES256 (P-256) only: the offline verifier is ES256-only (genesis alg), and
 * sealer delegate keys are always secp256r1. KS256-rooted delegation is a
 * server-only concern.
 *
 * Trust anchors (FOR-297 trust ladder): `rootKeys` need not be genesis-derived
 * — a caller-known log OWNER key works identically (see
 * `verifyReceiptOfflineWithKeys`), because the certificate issuer for a child
 * log IS its owner. What differs is why you trust the keys: genesis-derived
 * keys prove the key↔log binding from the bootstrap; a caller-known key merely
 * asserts it (provenance of the key is the only defence, and there is no grant
 * lifecycle visibility or split-view protection). The grant-chain walk
 * (approach A, open) will derive per-log owner keys from genesis + public
 * tiles, closing that gap without key distribution.
 *
 * Constraint enforcement (FOR-420): the certificate authorizes the delegated
 * key only over an MMR coverage window `[mmrStart, mmrEnd]` (payload labels 3/4)
 * and a validity window `[issuedAt, expiresAt]` (labels 8/9, Unix seconds).
 * {@link checkDelegationConstraints} enforces the soundly-offline-decidable
 * slice against the verified leaf: the `mmrEnd` over-horizon bound (the leaf's
 * index lower-bounds the checkpoint `treeSize-1` the on-chain
 * `delegationVerifier.sol` binds) and the validity window against the leaf's
 * snowflake idtimestamp (expiry-at-ISSUANCE, never wall-clock — receipts must
 * verify forever). The `mmrStart` lower bound and the exact `size-1` bound need
 * the checkpoint accumulator and are deferred (see that function). This replaces
 * the earlier "does not yet enforce the window" gap.
 */

import {
  coseUnprotectedToMap,
  decodeCborDeterministic,
  decodeCoseSign1,
  verifyCoseSign1WithParsedKey,
} from "@forestrie/encoding";

/** Unprotected header label carrying the delegation certificate. */
const DELEGATION_CERT_LABEL = 1000;

/** COSE_Key labels (RFC 9052) and EC2/P-256 constants. */
const COSE_KEY_KTY = 1;
const COSE_KEY_CRV = -1;
const COSE_KEY_X = -2;
const COSE_KEY_Y = -3;
const COSE_KTY_EC2 = 2;
const COSE_CRV_P256 = 1;

/** Delegation-cert payload labels (must match @forestrie/delegation-cose). */
const PAYLOAD_MMR_START = 3;
const PAYLOAD_MMR_END = 4;
const PAYLOAD_DELEGATED_KEY = 5;
const PAYLOAD_ISSUED_AT = 8;
const PAYLOAD_EXPIRES_AT = 9;

/**
 * Snowflake idtimestamp → Unix seconds (DataTrails scheme; arbor
 * `snowflakeid`). `TimeShift = 24`, per-epoch span `2^40 - 1` ms, current
 * `CommitmentEpoch = 1` (next epoch ~2038). `unixMs = epoch*(2^40-1) +
 * (id >> 24)`.
 */
const COMMITMENT_EPOCH = 1n;
const SNOWFLAKE_TIME_SHIFT = 24n;
const SNOWFLAKE_EPOCH_SPAN_MS = (1n << 40n) - 1n;

export function idtimestampToUnixSeconds(idtimestamp: bigint): number {
  const ms =
    COMMITMENT_EPOCH * SNOWFLAKE_EPOCH_SPAN_MS +
    (idtimestamp >> SNOWFLAKE_TIME_SHIFT);
  return Number(ms / 1000n);
}

/**
 * Coverage + validity window a root-signed delegation cert imposes on its
 * delegated key. `mmrStart`/`mmrEnd` are inclusive MMR-index bounds;
 * `issuedAt`/`expiresAt` are Unix seconds.
 */
export type DelegationConstraints = {
  mmrStart: bigint;
  mmrEnd: bigint;
  issuedAt: number;
  expiresAt: number;
};

/**
 * root-only: no delegation cert present — verify against the root keys as-is.
 * resolved: cert verified under a root key; use `delegatedKey` first.
 *   `constraints` carries the cert's coverage/validity window when the payload
 *   declares it (null for legacy certs that predate labels 3/4/8/9).
 * broken: a cert is present but did not verify under the root, or its delegated
 *   key could not be parsed — the delegation chain is invalid.
 */
export type DelegatedResolution =
  | { kind: "root-only" }
  | {
      kind: "resolved";
      delegatedKey: CryptoKey;
      constraints: DelegationConstraints | null;
    }
  | { kind: "broken" };

function extractDelegationCertBytes(unprotected: unknown): Uint8Array | null {
  const umap = coseUnprotectedToMap(unprotected);
  const certRaw = umap.get(DELEGATION_CERT_LABEL);
  return certRaw instanceof Uint8Array && certRaw.length > 0 ? certRaw : null;
}

function labelGetter(map: unknown): ((label: number) => unknown) | null {
  if (map instanceof Map) return (label) => map.get(label);
  if (typeof map === "object" && map !== null) {
    const obj = map as Record<string | number, unknown>;
    return (label) => obj[label] ?? obj[String(label)];
  }
  return null;
}

function parseCoseKeyEC2(
  keyMap: unknown,
): { x: Uint8Array; y: Uint8Array } | null {
  const get = labelGetter(keyMap);
  if (!get) return null;

  const kty = get(COSE_KEY_KTY);
  if (kty !== COSE_KTY_EC2 && kty !== BigInt(COSE_KTY_EC2)) return null;
  const crv = get(COSE_KEY_CRV);
  if (crv !== COSE_CRV_P256 && crv !== BigInt(COSE_CRV_P256)) return null;

  const x = get(COSE_KEY_X);
  const y = get(COSE_KEY_Y);
  if (!(x instanceof Uint8Array) || x.length !== 32) return null;
  if (!(y instanceof Uint8Array) || y.length !== 32) return null;
  return { x, y };
}

async function importDelegatedKey(keyMap: unknown): Promise<CryptoKey | null> {
  const parsed = parseCoseKeyEC2(keyMap);
  if (!parsed) return null;
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(parsed.x, 1);
  uncompressed.set(parsed.y, 33);
  try {
    return await crypto.subtle.importKey(
      "raw",
      uncompressed,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
  } catch {
    return null;
  }
}

function decodeCertPayloadMap(payloadBytes: Uint8Array): unknown | null {
  if (!payloadBytes || payloadBytes.length === 0) return null;
  try {
    return decodeCborDeterministic(payloadBytes);
  } catch {
    return null;
  }
}

function extractDelegatedKeyFromPayloadMap(
  payloadMap: unknown,
): unknown | null {
  const get = labelGetter(payloadMap);
  return get ? get(PAYLOAD_DELEGATED_KEY) : null;
}

function toBigIntOrNull(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  return null;
}

function toNumberOrNull(v: unknown): number | null {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/**
 * Parse the cert's coverage/validity window from its payload map. Returns null
 * when any of labels 3/4/8/9 is absent (legacy certs predating FOR-390 advance
 * delegation) — enforcement is then skipped, preserving pre-constraint trust.
 */
function parseDelegationConstraints(
  payloadMap: unknown,
): DelegationConstraints | null {
  const get = labelGetter(payloadMap);
  if (!get) return null;
  const mmrStart = toBigIntOrNull(get(PAYLOAD_MMR_START));
  const mmrEnd = toBigIntOrNull(get(PAYLOAD_MMR_END));
  const issuedAt = toNumberOrNull(get(PAYLOAD_ISSUED_AT));
  const expiresAt = toNumberOrNull(get(PAYLOAD_EXPIRES_AT));
  if (mmrStart === null || mmrEnd === null) return null;
  if (issuedAt === null || expiresAt === null) return null;
  return { mmrStart, mmrEnd, issuedAt, expiresAt };
}

/**
 * Enforce a resolved cert's constraints against the verified leaf (FOR-420).
 *
 * Coverage: the delegation authorizes checkpoint positions `treeSize-1 ∈
 * [mmrStart, mmrEnd]` (inclusive, `delegationVerifier.sol`). Offline we hold the
 * verified leaf's `mmrIndex`, and `leafMmrIndex ≤ treeSize-1` (the leaf is
 * included in the checkpoint). So `leafMmrIndex > mmrEnd` SOUNDLY implies
 * `treeSize-1 > mmrEnd` — a key signing beyond its authorized horizon — and is
 * rejected. The `mmrStart` lower bound is deliberately NOT enforced here: an
 * early leaf can legitimately appear in a checkpoint whose `size-1 ≥ mmrStart`,
 * so `leafMmrIndex < mmrStart` does not imply a violation and enforcing it would
 * false-reject valid receipts under a narrow cert. The lower bound and the exact
 * `size-1` upper bound need the checkpoint accumulator (absent in the single-peak
 * offline path) — deferred; in practice lane certs are wide (`mmrStart=0`).
 *
 * Validity: the leaf's issuance time (from its snowflake idtimestamp) must fall
 * within `[issuedAt, expiresAt]` — compared against the checkpoint/leaf time,
 * NOT wall-clock, so a valid receipt verifies forever. `not-yet-valid` is sound
 * (`leafTime ≤ checkpointTime`); `expired` uses the leaf time as the pinned
 * checkpoint-time proxy (ADR-0050 / FOR-297 semantics).
 */
export function checkDelegationConstraints(
  constraints: DelegationConstraints,
  leafMmrIndex: bigint,
  leafIdtimestamp: bigint,
): { ok: true } | { ok: false; reason: string } {
  if (leafMmrIndex > constraints.mmrEnd) {
    return { ok: false, reason: "delegation_out_of_range" };
  }
  const t = idtimestampToUnixSeconds(leafIdtimestamp);
  if (t < constraints.issuedAt) {
    return { ok: false, reason: "delegation_not_yet_valid" };
  }
  if (t > constraints.expiresAt) {
    return { ok: false, reason: "delegation_expired" };
  }
  return { ok: true };
}

/**
 * Resolve the delegated verify key from a receipt's delegation certificate.
 *
 * @param receiptCbor - the COSE_Sign1 receipt bytes.
 * @param rootKeys - genesis-derived ES256 root verify keys.
 */
export async function resolveDelegatedVerifyKey(
  receiptCbor: Uint8Array,
  rootKeys: CryptoKey[],
): Promise<DelegatedResolution> {
  const decoded = decodeCoseSign1(receiptCbor);
  if (!decoded) return { kind: "root-only" };

  const certBytes = extractDelegationCertBytes(decoded.unprotected);
  if (!certBytes) return { kind: "root-only" };

  let verified = false;
  for (const rootKey of rootKeys) {
    if (
      await verifyCoseSign1WithParsedKey(certBytes, rootKey, {
        logPrefix: "delegation-cert-offline",
      })
    ) {
      verified = true;
      break;
    }
  }
  if (!verified) return { kind: "broken" };

  const certDecoded = decodeCoseSign1(certBytes);
  if (!certDecoded) return { kind: "broken" };

  const payloadMap = decodeCertPayloadMap(certDecoded.payloadBstr);
  const keyRaw = payloadMap
    ? extractDelegatedKeyFromPayloadMap(payloadMap)
    : null;
  const delegatedKey = keyRaw ? await importDelegatedKey(keyRaw) : null;
  if (!delegatedKey) return { kind: "broken" };

  const constraints = parseDelegationConstraints(payloadMap);
  return { kind: "resolved", delegatedKey, constraints };
}
