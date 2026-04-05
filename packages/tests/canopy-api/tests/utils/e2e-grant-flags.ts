/**
 * 8-byte Forestrie-Grant bitmaps for e2e (univocity / ARC-0017).
 * @see packages/apps/canopy-api/src/grant/grant-flags.ts
 */

/** GF_CREATE|GF_EXTEND (byte 4), GF_AUTH_LOG (byte 7). */
export function authLogBootstrapShapedFlags(): Uint8Array {
  const grant = new Uint8Array(8);
  grant[4] = 0x03;
  grant[7] = 0x01;
  return grant;
}

/** GF_CREATE|GF_EXTEND (byte 4), GF_DATA_LOG (byte 7) only. */
export function dataLogCreateExtendFlags(): Uint8Array {
  const grant = new Uint8Array(8);
  grant[4] = 0x03;
  grant[7] = 0x02;
  return grant;
}
