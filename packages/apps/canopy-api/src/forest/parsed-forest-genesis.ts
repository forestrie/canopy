import type { ForestGenesisChainBinding } from "./genesis-wire.js";

export interface ParsedForestGenesis {
  /** Forest root log id (16-byte UUID). */
  wire: Uint8Array;
  schemaVersion: 0 | 1 | 2;
  chainBinding: ForestGenesisChainBinding | null;
  /** ES256 P-256 x (v0/v1 EC2 documents). */
  x?: Uint8Array;
  /** ES256 P-256 y (v0/v1 EC2 documents). */
  y?: Uint8Array;
  /** COSE alg (v2 alg/key documents). */
  bootstrapAlg?: number;
  /** 64-byte x‖y (ES256) or 20-byte address (KS256) for v2. */
  bootstrapKey?: Uint8Array;
}
