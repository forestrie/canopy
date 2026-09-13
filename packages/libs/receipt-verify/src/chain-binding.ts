/**
 * Genesis-bound chain binding: which univocity contract and chain a
 * forest's on-chain checkpoints are anchored to, plus the forest's own log
 * id (labels -68011 / -68013 / -68010). Bound once at genesis and public
 * (ADR-0045) — the address and chain id are properties of the FOREST, not
 * of the operator serving it. See {@link decodeChainBindingFromGenesis}.
 * Mirrors mcp-resolve's `ChainBinding` (plan-2609-07 L3) so that consumer
 * can delete its own copy, except `logId` here is the raw 32-byte wire
 * value rather than a formatted UUID string.
 */
export interface ChainBinding {
  /** `0x` + 40 lowercase hex univocity contract address. */
  univocity: string;
  chainId: number;
  /** Raw 32 bytes of label -68010: 16 zero bytes then the 16-byte forest
   *  bootstrap log id. */
  logId: Uint8Array;
}
