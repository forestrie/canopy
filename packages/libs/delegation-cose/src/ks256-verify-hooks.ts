/**
 * Optional ERC-1271 verification hooks for KS256 contract-wallet log roots.
 * Injected by delegation-coordinator when the trusted root address has bytecode
 * on chain — EOA roots omit hooks and use ecrecover instead.
 */

/** Optional ERC-1271 hooks for KS256 contract-wallet roots. */
export interface Ks256VerifyHooks {
  /**
   * @param address - 20-byte root signer address from protected header kid.
   * @returns `true` when the address has deployed contract code.
   */
  hasContractCode(address: Uint8Array): Promise<boolean>;
  /**
   * ERC-1271 `isValidSignature` check for contract roots.
   *
   * @param address - Contract address that must validate the signature.
   * @param hash - keccak256(Sig_structure) digest.
   * @param signature - KS256 signature bytes from the COSE envelope.
   */
  isValidSignature(
    address: Uint8Array,
    hash: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean>;
}
