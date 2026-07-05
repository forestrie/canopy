/**
 * 8-byte Forestrie-Grant bitmaps for e2e (univocity / ARC-0017).
 * @see packages/apps/canopy-api/src/grant/grant-flags.ts
 */

export {
  authLogBootstrapShapedFlags,
  derivedEndorsementGrantFlags,
} from "./wire/grant/grant-flags.js";

/** GF_CREATE|GF_EXTEND (byte 3), GF_DATA_LOG (byte 7) only. */
export function dataLogCreateExtendFlags(): Uint8Array {
  const grant = new Uint8Array(8);
  grant[3] = 0x03;
  grant[7] = 0x02;
  return grant;
}
