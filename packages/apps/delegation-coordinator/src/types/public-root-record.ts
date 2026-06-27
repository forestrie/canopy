/**
 * Stored BYOK log public root record shape.
 *
 * Persisted in {@link DelegationStoreDO} `public_roots` table after user upload.
 */

/** Registered public root key material for wallet auth and cert verify. */
export interface PublicRootRecord {
  logIdHex32: string;
  alg: string;
  x: Uint8Array;
  y: Uint8Array;
  uploadedAt: number;
}
