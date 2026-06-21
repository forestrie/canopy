/** Optional ERC-1271 hooks for KS256 contract-wallet roots. */
export interface Ks256VerifyHooks {
  hasContractCode(address: Uint8Array): Promise<boolean>;
  isValidSignature(
    address: Uint8Array,
    hash: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean>;
}
