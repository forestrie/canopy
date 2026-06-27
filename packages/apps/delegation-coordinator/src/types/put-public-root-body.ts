/**
 * Internal DO JSON body for PUT /public-root/{logIdHex32}.
 *
 * Forwarded from HTTP handlers after public-root POST normalization.
 */

/** Stored public root fields written by {@link DelegationStoreDO}. */
export interface PutPublicRootBody {
  logIdHex32: string;
  alg: string | number;
  x?: string;
  y?: string;
  key?: string;
}
