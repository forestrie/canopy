/** Delegated EC2 P-256 public key coordinates from payload field 5. */
export interface ParsedDelegatedKey {
  x: Uint8Array;
  y: Uint8Array;
}
