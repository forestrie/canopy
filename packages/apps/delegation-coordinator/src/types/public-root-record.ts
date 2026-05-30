/** Stored BYOK log root public key per log id. */
export interface PublicRootRecord {
  logIdHex32: string;
  alg: string;
  x: Uint8Array;
  y: Uint8Array;
  uploadedAt: number;
}
