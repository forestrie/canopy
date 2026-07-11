/**
 * On-chain grant content aligned with univocity `PublishGrant`:
 * `logId`, `grant`, `request`, `maxHeight`, `minGrowth`, `ownerLogId`, `grantData`.
 *
 * Idtimestamp is always separate (header / leaf). The Forestrie-Grant v0 CBOR map carries
 * only these fields (keys 1–6); issuer attestation uses **`grantData`** in the commitment
 * preimage. The inner-grant wire format is documented in grants.md §3.1:
 * https://github.com/forestrie/canopy/blob/main/docs/grants.md#31-inner-grant-payload-cbor
 */

import type { GrantData } from "./grant-data.js";

/**
 * Strict chain-shaped grant (Solidity `PublishGrant`). `grant` is the flags bitmap (8-byte wire
 * form; preimage pads to 32 bytes). `request` is not included in the grant commitment preimage.
 */
export interface Grant {
  /** Target log id (16-byte UUID). */
  logId: Uint8Array;
  /** Grant flags `uint256` / 8-byte wire bitmap (GF_*). */
  grant: Uint8Array;
  /** Request code (`uint256`); omitted from inner/commitment hash. */
  request?: bigint;
  maxHeight?: number;
  minGrowth?: number;
  /** Owner (authority) log id (16-byte UUID). */
  ownerLogId: Uint8Array;
  /** Opaque committed bytes, or a structured {@link GrantData} until normalized. */
  grantData: Uint8Array | GrantData;
}
