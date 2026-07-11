/**
 * Grant flags (univocity alignment). 8-byte wire `grant` bitmap. GF_CREATE and
 * GF_EXTEND are bits in byte index 3, and GF_DERIVED is byte-3 mask 0x04, so that
 * once the 8 wire bytes are placed in the low 8 bytes of the 32-byte grant
 * commitment (grant-commitment.ts `grantFlags32`, go-univocity `padGrant32`) and
 * read as a big-endian uint256 by the contract, they land on bits **32 / 33 / 34**
 * — the univocity constants `GF_CREATE = 1<<32`, `GF_EXTEND = 1<<33`,
 * `GF_DERIVED = 1<<34` (`interfaces/constants.sol`). Byte 3 (not byte 4) is
 * load-bearing: byte 4 would land on bits 24/25/26 and the contract's first
 * checkpoint would revert `GrantRequirement` (FOR-328). Low byte (index 7):
 * **GF_AUTH_LOG** = 0x01, **GF_DATA_LOG** = 0x02 (mutually exclusive for
 * statement-registration grants) — bit 0/1, already contract-aligned. Flag
 * shapes and how they select register-grant branches are documented in grants.md §5:
 * https://github.com/forestrie/canopy/blob/main/docs/grants.md#5-flag-shapes-statement-registration-vs-other-grants
 */

/** 8-byte `grant` field; byte 3: GF_CREATE (bit 0), GF_EXTEND (bit 1) in lower bits of that byte. */
export function hasCreateAndExtend(grant: Uint8Array): boolean {
  if (grant.length < 8) return false;
  const byte3 = grant[3] ?? 0;
  return (byte3 & 0x03) === 0x03;
}

/** True if GF_EXTEND is set (byte 3 bit 1), including GF_CREATE|GF_EXTEND. */
export function hasExtendCapability(grant: Uint8Array): boolean {
  if (grant.length < 8) return false;
  return ((grant[3] ?? 0) & 0x02) !== 0;
}

/** GF_DATA_LOG (0x02) in low byte without GF_AUTH_LOG (0x01). */
export function hasDataLogClass(grant: Uint8Array): boolean {
  if (grant.length < 8) return false;
  const low = grant[7] ?? 0;
  return (low & 0x02) !== 0 && (low & 0x01) === 0;
}

/** GF_AUTH_LOG (0x01) in low byte without GF_DATA_LOG (0x02). */
export function hasAuthLogClass(grant: Uint8Array): boolean {
  if (grant.length < 8) return false;
  const low = grant[7] ?? 0;
  return (low & 0x01) !== 0 && (low & 0x02) === 0;
}

/** GF_CREATE|GF_EXTEND (byte 3), GF_AUTH_LOG (byte 7) — child auth opening grant shape. */
export function authLogBootstrapShapedFlags(): Uint8Array {
  const grant = new Uint8Array(8);
  grant[3] = 0x03;
  grant[7] = 0x01;
  return grant;
}

/** GF_CREATE|GF_EXTEND (byte 3), GF_DATA_LOG (byte 7) only. */
export function dataLogCreateExtendFlags(): Uint8Array {
  const grant = new Uint8Array(8);
  grant[3] = 0x03;
  grant[7] = 0x02;
  return grant;
}

/** Register-signed-statement: data-log grant with extend (or create+extend) capability. */
export function isDataLogStatementGrantFlags(grant: Uint8Array): boolean {
  return hasExtendCapability(grant) && hasDataLogClass(grant);
}

/** GF_DERIVED (univocity bit 34) on canopy wire byte 3, mask 0x04. */
export function hasDerivedFlag(grant: Uint8Array): boolean {
  if (grant.length < 8) return false;
  return ((grant[3] ?? 0) & 0x04) !== 0;
}

/** GF_DERIVED + GF_EXTEND + GF_AUTH_LOG — endorsement leaf shape. */
export function derivedEndorsementGrantFlags(): Uint8Array {
  const grant = new Uint8Array(8);
  grant[3] = 0x06; // GF_EXTEND | GF_DERIVED
  grant[7] = 0x01; // GF_AUTH_LOG
  return grant;
}

/** Extend-only derived leaf appended on owner log O (logId = R', ownerLogId = R). */
export function isDerivedEndorsementGrant(grant: Uint8Array): boolean {
  return (
    hasDerivedFlag(grant) &&
    hasExtendCapability(grant) &&
    !hasCreateAndExtend(grant)
  );
}
