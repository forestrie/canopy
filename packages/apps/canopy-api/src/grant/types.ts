/**
 * Grant format types (Plan 0001 Step 1).
 * Aligns with Brainstorm-0001 §7 and univocity leaf commitment shape.
 * logId, ownerLogId, grantFlags, kind are bytes for Solidity/safety.
 */

export const GRANT_VERSION = 1;

/** Signer binding: key id or public key bytes; identifies who may use this grant at register-statement. */
export type SignerBinding = Uint8Array;

export interface Grant {
  /** Protocol version; must be 1 in this phase. */
  version: number;
  /** Unique grant timestamp / nonce (8 bytes). */
  idtimestamp: Uint8Array;
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

/** Grant request (body of POST /logs/{logId}/grants). Same shape as Grant but idtimestamp may be omitted (server fills). */
export type GrantRequest = Omit<Grant, "idtimestamp"> & {
  idtimestamp?: Uint8Array;
};
