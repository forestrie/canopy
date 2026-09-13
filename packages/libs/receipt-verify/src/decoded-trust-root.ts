import type { RootVerifyKey } from "./root-verify-key.js";

/**
 * Result of {@link decodeTrustRootDetailsFromGenesis}: the decoded verify
 * key (an ES256 `CryptoKey`, or a KS256 on-chain address) plus, for the
 * ES256 case, the raw 64-byte x||y P-256 public key coordinates the genesis
 * document carries. `bootstrapKeyXy` is read directly from the
 * genesis-encoded bytes, not exported from `key` (`key` stays
 * non-extractable) — plan-2609-07 L3, for callers that need the
 * serialisable public key material the `CryptoKey` cannot give up.
 * `bootstrapKeyXy` is `undefined` for a KS256 v2 bootstrap key (an on-chain
 * address — there is no P-256 public key to give up).
 */
export interface DecodedTrustRoot {
  key: RootVerifyKey;
  bootstrapKeyXy?: Uint8Array;
}
