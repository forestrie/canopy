/**
 * Caller-known log key bytes → trust key (FOR-297 "known log key"; plan-2610-03
 * D6). The bytes alone decide the type, as univocity's
 * `GrantDataInvalidKeyLength` and arbor's `grantDataIdentity` do: 64 bytes is
 * an ES256 x||y public key, 20 bytes a KS256 address, anything else is
 * refused. Either way the caller ASSERTS, and does not prove, that the key
 * owns the log — see `verifyReceiptOfflineWithKeys`.
 */

import {
  importEs256PublicKeyFromGrantDataXy64,
  ks256RootFromAddress,
} from "./decode-trust-root-cbor.js";
import type { RootVerifyKey } from "./root-verify-key.js";

/**
 * @param bytes - 64-byte ES256 x||y or 20-byte KS256 address.
 * @throws When the length is neither.
 */
export async function knownLogKeyFromBytes(
  bytes: Uint8Array,
): Promise<RootVerifyKey> {
  if (bytes.length === 64) return importEs256PublicKeyFromGrantDataXy64(bytes);
  if (bytes.length === 20) return ks256RootFromAddress(bytes);
  throw new Error(
    `known log key must be 64 bytes (ES256 x||y) or 20 bytes (KS256 address), got ${bytes.length}`,
  );
}
