/**
 * Grant flags (univocity alignment). 8-byte wire `grant` bitmap; GF_CREATE and GF_EXTEND
 * are bits in byte index 4 (brainstorm-0001 / univocity).
 *
 * Low byte (index 7): **GF_AUTH_LOG** = 0x01, **GF_DATA_LOG** = 0x02 (mutually exclusive
 * for statement-registration grants; see univocity `constants.sol` when in-repo).
 */

/** 8-byte `grant` field; byte 4: GF_CREATE (bit 0), GF_EXTEND (bit 1) in lower bits of that byte. */
export function hasCreateAndExtend(grant: Uint8Array): boolean {
  if (grant.length < 8) return false;
  const byte4 = grant[4] ?? 0;
  return (byte4 & 0x03) === 0x03;
}

/** True if GF_EXTEND is set (byte 4 bit 1), including GF_CREATE|GF_EXTEND. */
export function hasExtendCapability(grant: Uint8Array): boolean {
  if (grant.length < 8) return false;
  return ((grant[4] ?? 0) & 0x02) !== 0;
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

/** GF_CREATE|GF_EXTEND (byte 4), GF_AUTH_LOG (byte 7) — child auth opening grant shape. */
export function authLogBootstrapShapedFlags(): Uint8Array {
  const grant = new Uint8Array(8);
  grant[4] = 0x03;
  grant[7] = 0x01;
  return grant;
}

/** Register-signed-statement: data-log grant with extend (or create+extend) capability. */
export function isDataLogStatementGrantFlags(grant: Uint8Array): boolean {
  return hasExtendCapability(grant) && hasDataLogClass(grant);
}
