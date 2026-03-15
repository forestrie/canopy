/**
 * Grant format type (Plan 0001 Step 1, Plan 0006).
 * Aligns with univocity PublishGrant: content only; idtimestamp is always a separate parameter.
 */

export const GRANT_VERSION = 1;

/** Signer binding: key id or public key bytes; identifies who may use this grant at register-statement. */
export type SignerBinding = Uint8Array;

/** Grant (publish-grant content only). Idtimestamp is supplied separately where needed (e.g. header -65537, massif). */
export interface Grant {
  /** Protocol version; must be 1 in this phase. */
  version: number;
  /** Target log (the log this grant authorizes). 16 bytes for UUID. */
  logId: Uint8Array;
  /** Owner (authority) log that owns this grant. 16 bytes for UUID. */
  ownerLogId: Uint8Array;
  /** Grant flags bitmap. 8 bytes. */
  grantFlags: Uint8Array;
  /** Optional max height (bounds). */
  maxHeight?: number;
  /** Optional min growth (bounds). */
  minGrowth?: number;
  /** Opaque grant data (e.g. signer key for first checkpoint). */
  grantData: Uint8Array;
  /** Signer binding: key id or public key bytes; must match statement signer at register-statement. */
  signer: SignerBinding;
  /** Grant kind: 1 byte (uint8, Solidity-aligned). */
  kind: Uint8Array;
  /** Optional expiry (Unix time seconds). */
  exp?: number;
  /** Optional not-before (Unix time seconds). */
  nbf?: number;
}

/** Grant request (body of POST /logs/{logId}/grants). Same as Grant (content only). */
export type GrantRequest = Grant;
