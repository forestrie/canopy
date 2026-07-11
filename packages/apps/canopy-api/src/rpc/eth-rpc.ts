/** Re-export chain RPC helpers used by canopy-api onboarding and KS256 verify. */
export {
  bytesToHex,
  ethCall,
  ethCallWithFailover,
  ethRpc,
  ethRpcWithFailover,
  hasContractCodeAt,
  hexAddressToBytes,
  normalizeHexAddress,
} from "@forestrie/chain-rpc";
