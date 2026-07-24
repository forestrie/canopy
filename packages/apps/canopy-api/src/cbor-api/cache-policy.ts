/**
 * Cache policy for canopy responses (FOR-302, ADR-0057).
 *
 * The rule is the same one arbor applies when it publishes log objects, because
 * it is the same question: may this content still change?
 *
 * A massif is overwritten in place on every commit until it is full, then
 * frozen forever. Anything derived from an *open* massif — notably an assembled
 * receipt, which `resolve-receipt` builds from the latest checkpoint for that
 * massif — is therefore still subject to change, and must not be cached.
 * Anything derived from a complete massif is terminal and may be cached
 * indefinitely.
 *
 * Content that is not about massifs at all (token lists, revocation status,
 * registration state) is mutable by nature and is never cacheable. The previous
 * default stamped every 2xx CBOR response `immutable, max-age=31536000`, which
 * pinned exactly that kind of state for a year — a revoked token could still
 * read as valid from cache. The default is now no-store, so immutability is an
 * explicit claim a handler makes rather than something it inherits by accident.
 */

import { massifLogEntries } from "@forestrie/merklelog";

/** Content that can never legitimately change again. */
export const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";

/** Content that may still change, and every error response. */
export const CACHE_CONTROL_NO_STORE = "no-store";

export const IMMUTABLE_HEADERS = {
  "cache-control": CACHE_CONTROL_IMMUTABLE,
} as const;

export const NO_STORE_HEADERS = {
  "cache-control": CACHE_CONTROL_NO_STORE,
} as const;

/** Node count of a complete massif at `massifHeight`: (1 << h) - 1. */
export function massifTreeCount(massifHeight: number): bigint {
  return (1n << BigInt(massifHeight)) - 1n;
}

/**
 * Whether a massif payload holds a full tree for its height — i.e. no further
 * entry can be appended, so it and anything derived from it are terminal.
 *
 * A short or malformed payload is reported incomplete: content we cannot prove
 * is final must not be published as immutable.
 */
export function massifDataComplete(
  dataLen: number,
  massifHeight: number,
): boolean {
  try {
    return (
      massifLogEntries(dataLen, massifHeight) >= massifTreeCount(massifHeight)
    );
  } catch {
    return false;
  }
}

/** Cache-Control for content derived from a massif of known completeness. */
export function cacheControlForMassifDerived(
  dataLen: number,
  massifHeight: number,
): string {
  return massifDataComplete(dataLen, massifHeight)
    ? CACHE_CONTROL_IMMUTABLE
    : CACHE_CONTROL_NO_STORE;
}
