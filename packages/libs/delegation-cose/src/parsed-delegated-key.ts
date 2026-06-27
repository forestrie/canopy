/**
 * EC2 P-256 delegated public key extracted from payload label 5. Sealer
 * generates the ephemeral checkpoint key; this type holds the coordinates
 * sealer verifies match its local key before signing checkpoints.
 */

/** Delegated EC2 P-256 public key coordinates from payload field 5. */
export interface ParsedDelegatedKey {
  /** P-256 x coordinate (32 bytes). */
  x: Uint8Array;
  /** P-256 y coordinate (32 bytes). */
  y: Uint8Array;
}
