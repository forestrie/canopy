/**
 * Offline delegation-chain resolution (FOR-297). When a checkpoint/receipt was
 * signed by a DELEGATED key rather than the log's root key, the delegation
 * certificate travels in the receipt's unprotected header at label 1000
 * (sealer-embedded). This module verifies that certificate under the genesis
 * trust root and returns the delegated public key as an additional verify
 * candidate — the offline port of canopy-api's `resolveReceiptVerifyKey`.
 *
 * Sealer delegate keys are always secp256r1. A P-256 root's certificate is
 * checked here; a passkey (WebAuthn) root signs the certificate with alg
 * -65800 and the ADR-0063 unprotected-header envelope, which
 * `verifyCoseSign1WithParsedKey` verifies against the same P-256 root keys
 * (plan-2608-13 1.4). A KS256 root's certificate is checked by
 * {@link verifyKs256DelegationCert}: ecrecover for an EOA, or a caller-supplied
 * ERC-1271 attestation for a contract (plan-2610-03 D4).
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
 * and until `expiresAt` (label 9, Unix seconds). {@link checkDelegationConstraints}
 * enforces the soundly-offline-decidable slice against the verified leaf: the
 * `mmrEnd` over-horizon bound (the leaf's index lower-bounds the checkpoint
 * `treeSize-1` the on-chain `delegationVerifier.sol` binds) and expiry-at-issuance
 * against the leaf's snowflake idtimestamp (never wall-clock — receipts must
 * verify forever). The `mmrStart` lower bound, the exact `size-1` bound, and the
 * `issuedAt` lower bound are NOT enforced (see that function). This replaces the
 * earlier "does not yet enforce the window" gap.
 */

import {
  coseUnprotectedToMap,
  decodeCborDeterministic,
  decodeCoseSign1,
  toUint64,
  verifyCoseSign1WithParsedKey,
} from "@forestrie/encoding";
import { toSafeUint } from "@forestrie/delegation-cose";
import { isParsedKs256RootKey, type RootVerifyKey } from "./root-verify-key.js";
import {
  verifyKs256DelegationCert,
  type Ks256DelegationEvidence,
} from "./verify-ks256-delegation.js";

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
  return Math.floor(idtimestampToUnixMs(idtimestamp) / 1000);
}

/**
 * Snowflake idtimestamp → Unix milliseconds: the time component an
 * ADR-0065 §3 endorsement window is expressed in
 * (`ms = (id >> TimeShift) + EpochMS(epoch)`).
 */
export function idtimestampToUnixMs(idtimestamp: bigint): number {
  return Number(
    COMMITMENT_EPOCH * SNOWFLAKE_EPOCH_SPAN_MS +
      (idtimestamp >> SNOWFLAKE_TIME_SHIFT),
  );
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
 *   declares one (null for a legacy cert with neither label 3 nor 4).
 * broken: a cert is present but did not verify under the root, or its delegated
 *   key could not be parsed, or its window is malformed
 *   (`delegation_range_malformed`: only one of labels 3/4, a range label that
 *   is not a uint64, `mmrStart > mmrEnd`, or labels 8/9 absent or not a
 *   non-negative integer alongside a range) — the delegation chain is
 *   invalid. `reason` is set when it is more specific than
 *   `delegation_invalid`.
 */
export type DelegatedResolution =
  | { kind: "root-only" }
  | {
      kind: "resolved";
      delegatedKey: CryptoKey;
      constraints: DelegationConstraints | null;
    }
  | { kind: "broken"; reason?: string };

function extractDelegationCertBytes(unprotected: unknown): Uint8Array | null {
  const umap = coseUnprotectedToMap(unprotected);
  const certRaw = umap.get(DELEGATION_CERT_LABEL);
  return certRaw instanceof Uint8Array && certRaw.length > 0 ? certRaw : null;
}

function labelGetter(map: unknown): ((label: number) => unknown) | null {
  if (map instanceof Map) return (label) => map.get(label);
  if (typeof map === "object" && map !== null) {
    // Presence, not truthiness: a label present as null is not absent.
    const obj = map as Record<string, unknown>;
    return (label) => (String(label) in obj ? obj[String(label)] : undefined);
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

/**
 * Parse the cert's coverage/validity window from its payload map.
 *
 * Labels 3 (mmrStart) AND 4 (mmrEnd) both absent is a legacy certificate: it
 * declares no window, returns null and enforcement is skipped, whatever
 * labels 8/9 hold (arbor's builder omits 3/4 for a cert without a log id).
 * Once either range label is present the window must be complete and well
 * formed: both 3 and 4 uint64 with `mmrStart <= mmrEnd`, and 8/9 (issuedAt,
 * expiresAt, Unix seconds) non-negative safe integers. Anything else throws,
 * so a malformed window can never pass as "no window". arbor's sealer and
 * delegation-cose's `parseDelegationCertificate` reject the same range
 * values ([delegationcert](https://github.com/forestrie/arbor/tree/main/services/pkgs/delegationcert)).
 *
 * @throws When the window is incomplete or a label is not an integer of
 *   the required range.
 */
function parseDelegationConstraints(
  payloadMap: unknown,
): DelegationConstraints | null {
  const get = labelGetter(payloadMap);
  if (!get) return null;
  const rawStart = get(PAYLOAD_MMR_START);
  const rawEnd = get(PAYLOAD_MMR_END);
  if (rawStart === undefined && rawEnd === undefined) return null;
  const mmrStart = toUint64(rawStart, "delegation mmrStart");
  const mmrEnd = toUint64(rawEnd, "delegation mmrEnd");
  if (mmrStart > mmrEnd) {
    throw new Error(`delegation mmrStart ${mmrStart} > mmrEnd ${mmrEnd}`);
  }
  const issuedAt = toSafeUint(get(PAYLOAD_ISSUED_AT), "delegation issuedAt");
  const expiresAt = toSafeUint(get(PAYLOAD_EXPIRES_AT), "delegation expiresAt");
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
 * Expiry-at-issuance: the leaf's time (from its snowflake idtimestamp) must not
 * be AFTER the cert's `expiresAt` — a key signing past its authorized lifetime.
 * Compared against the checkpoint/leaf time, NOT wall-clock, so a valid receipt
 * verifies forever (the pinned FOR-297 / ADR-0050 requirement).
 *
 * The `issuedAt` lower bound is deliberately NOT enforced. `issuedAt` is when the
 * cert was SIGNED; the leaf's idtimestamp is when it was SEQUENCED. On live lanes
 * the delegation cert is signed a few seconds AFTER the leaf is sequenced (the
 * checkpoint that includes the leaf is sealed reactively), so `issuedAt > leafTime`
 * is normal and correct — the cert is never *used* to sign before it exists.
 * Enforcing `issuedAt ≤ leafTime` false-rejects legitimate receipts (verified on
 * lane A: a fresh bootstrap receipt has `issuedAt − leafTime ≈ 3s`).
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
  if (t > constraints.expiresAt) {
    return { ok: false, reason: "delegation_expired" };
  }
  return { ok: true };
}

/**
 * Resolve the delegated verify key from a receipt's delegation certificate.
 *
 * @param receiptCbor - the COSE_Sign1 receipt bytes.
 * @param rootKeys - trust roots: ES256 keys and KS256 addresses, from genesis
 *   or caller-known log keys. A KS256 root never comes from the coordinator
 *   (its public roots are last-write-wins, FOR-601/FOR-603).
 * @param ks256Evidence - optional ERC-1271 attestation for a KS256 contract
 *   root, with the forest's genesis chain id it must match.
 */
export async function resolveDelegatedVerifyKey(
  receiptCbor: Uint8Array,
  rootKeys: RootVerifyKey[],
  ks256Evidence: Ks256DelegationEvidence = {},
): Promise<DelegatedResolution> {
  const decoded = decodeCoseSign1(receiptCbor);
  if (!decoded) return { kind: "root-only" };

  const certBytes = extractDelegationCertBytes(decoded.unprotected);
  if (!certBytes) return { kind: "root-only" };

  let verified = false;
  let ks256Reason: string | undefined;
  for (const rootKey of rootKeys) {
    if (isParsedKs256RootKey(rootKey)) {
      const check = await verifyKs256DelegationCert(
        certBytes,
        rootKey.address,
        ks256Evidence,
      );
      if (check.ok) {
        verified = true;
        break;
      }
      ks256Reason ??= check.reason;
      continue;
    }
    if (
      await verifyCoseSign1WithParsedKey(certBytes, rootKey, {
        logPrefix: "delegation-cert-offline",
      })
    ) {
      verified = true;
      break;
    }
  }
  if (!verified) return { kind: "broken", reason: ks256Reason };

  const certDecoded = decodeCoseSign1(certBytes);
  if (!certDecoded) return { kind: "broken" };

  const payloadMap = decodeCertPayloadMap(certDecoded.payloadBstr);
  const keyRaw = payloadMap
    ? extractDelegatedKeyFromPayloadMap(payloadMap)
    : null;
  const delegatedKey = keyRaw ? await importDelegatedKey(keyRaw) : null;
  if (!delegatedKey) return { kind: "broken" };

  let constraints: DelegationConstraints | null;
  try {
    constraints = parseDelegationConstraints(payloadMap);
  } catch {
    // A malformed window is a broken chain, never "no window".
    return { kind: "broken", reason: "delegation_range_malformed" };
  }
  return { kind: "resolved", delegatedKey, constraints };
}
