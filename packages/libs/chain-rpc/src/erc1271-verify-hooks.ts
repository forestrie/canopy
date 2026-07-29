/**
 * Shared ERC-1271 verify-hooks factory for KS256 contract-account roots
 * (plan-2607-45 Safe 1x1 Mode D). One implementation of the
 * `eth_getCode` / `isValidSignature` pair for every KS256 verifier — the
 * grant path, the onboarding/account-read CWT verifier, and the
 * delegation-coordinator all consume this instead of keeping copies.
 *
 * Hooks PROPAGATE RPC errors: a caller that must fail closed (never fall
 * back to ecrecover for an address that may hold code) catches and rejects;
 * a caller that prefers to swallow wraps the hook itself.
 */

import {
  bytesToHex,
  ethCallWithFailover,
  hasContractCodeAt,
} from "./eth-rpc.js";
import type { EthRpcOptions } from "./eth-rpc.js";

/** `isValidSignature(bytes32,bytes)` selector. */
const ERC1271_SELECTOR = "1626ba7e";

/** Magic value (the selector, as bytes4) a valid signature check returns. */
const ERC1271_MAGIC = "0x1626ba7e";

/**
 * ERC-1271 verification hooks. Structurally identical to
 * `Ks256VerifyHooks` in `@forestrie/delegation-cose` — kept nominal-free
 * here so this package stays dependency-less.
 */
export interface Erc1271VerifyHooks {
  /**
   * @param address - 20-byte account address.
   * @returns `true` when the address has deployed contract code.
   * @throws When every RPC endpoint fails.
   */
  hasContractCode(address: Uint8Array): Promise<boolean>;
  /**
   * ERC-1271 `isValidSignature` check for contract accounts.
   *
   * @param address - Contract address that must validate the signature.
   * @param hash - 32-byte digest (keccak256 of Sig_structure for KS256).
   * @param signature - Signature bytes from the COSE envelope; contract
   *   signatures are NOT length-restricted (a Safe owner signature is not
   *   the 65-byte EOA blob).
   * @throws When every RPC endpoint fails.
   */
  isValidSignature(
    address: Uint8Array,
    hash: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean>;
}

/**
 * ABI-encode an `isValidSignature(bytes32,bytes)` call without an ABI
 * library: selector ‖ hash ‖ offset(0x40) ‖ length ‖ right-padded bytes.
 *
 * @param hash - 32-byte digest.
 * @param signature - Arbitrary-length signature bytes.
 */
export function encodeIsValidSignatureCall(
  hash: Uint8Array,
  signature: Uint8Array,
): string {
  if (hash.length !== 32) {
    throw new Error("ERC-1271 hash must be 32 bytes");
  }
  const word = (n: number) => n.toString(16).padStart(64, "0");
  const sigPadded = bytesToHex(signature).padEnd(
    Math.ceil(signature.length / 32) * 64,
    "0",
  );
  return `0x${ERC1271_SELECTOR}${bytesToHex(hash)}${word(0x40)}${word(signature.length)}${sigPadded}`;
}

/**
 * Build ERC-1271 hooks over JSON-RPC with failover.
 *
 * The magic-value check accepts the returned word by PREFIX: `eth_call`
 * returns the `bytes4` ABI-encoded as a right-zero-padded 32-byte word, so
 * strict equality against `0x1626ba7e` would reject every genuine
 * contract signature.
 *
 * @param rpcUrls - Preference-ordered endpoints for the binding chain.
 * @param options - Per-request timeout passed to each attempt.
 */
export function createErc1271VerifyHooks(
  rpcUrls: string[],
  options: EthRpcOptions = {},
): Erc1271VerifyHooks {
  return {
    async hasContractCode(address: Uint8Array): Promise<boolean> {
      return hasContractCodeAt(rpcUrls, bytesToHex(address), options);
    },
    async isValidSignature(
      address: Uint8Array,
      hash: Uint8Array,
      signature: Uint8Array,
    ): Promise<boolean> {
      const result = await ethCallWithFailover(
        rpcUrls,
        `0x${bytesToHex(address)}`,
        encodeIsValidSignatureCall(hash, signature),
        options,
      );
      return (
        typeof result === "string" &&
        result.toLowerCase().startsWith(ERC1271_MAGIC)
      );
    },
  };
}
