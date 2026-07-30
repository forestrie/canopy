/**
 * KS256 signature verification for wcc-1 control-plane challenges.
 *
 * EOA roots: `personal_sign` recovery, matched against the stored KS256
 * public root per
 * [univocity docs/arc](https://github.com/forestrie/univocity/blob/main/docs/arc/).
 *
 * Contract-account roots (Safe 1x1 Mode D, plan-2607-04 R1 / FOR-505): a
 * contract can never produce `personal_sign`, so when the registered root
 * has code the signature is the owner's SafeMessage wrap of the SAME EIP-191
 * challenge digest, and the root contract decides via ERC-1271
 * `isValidSignature(digest, signature)` — the exact dispatch shape of the
 * certificate verifiers.
 */

import { hashMessage, hexToBytes, recoverMessageAddress } from "viem";
import { Erc1271UnavailableError } from "@forestrie/chain-rpc";
import type { Ks256VerifyHooks } from "@forestrie/delegation-cose";
import { buildKs256ControlPlaneMessage } from "./challenge-message.js";
import { ks256AddressMatchesRoot } from "./public-root-match.js";
import type { WalletChallengeEnvelope } from "../../types/wallet-challenge.js";

/**
 * Recover KS256 signer address from personal_sign over wcc-1 message.
 *
 * @param envelope - Challenge envelope presented to the wallet.
 * @param signature - Hex personal_sign signature.
 * @returns Recovered address or null when recovery fails.
 */
export async function verifyKs256ControlPlaneSignature(
  envelope: WalletChallengeEnvelope,
  signature: string,
): Promise<`0x${string}` | null> {
  const message = buildKs256ControlPlaneMessage(envelope);
  try {
    const recovered = await recoverMessageAddress({
      message,
      signature: signature as `0x${string}`,
    });
    return recovered;
  } catch {
    return null;
  }
}

/**
 * Root-aware verdict for a KS256 challenge signature.
 *
 * - `valid` — the registered root authorised the challenge.
 * - `invalid_signature` — the signature could not be parsed/recovered.
 * - `signer_mismatch` — a well-formed signature the root did not authorise
 *   (EOA recovery mismatch, or the root contract returned non-magic).
 * - `unavailable` — every RPC endpoint failed while asking the contract;
 *   an availability outcome, NOT a verification verdict (503, never 403).
 */
export type Ks256ChallengeVerdict =
  | "valid"
  | "invalid_signature"
  | "signer_mismatch"
  | "unavailable";

/**
 * Verify a KS256 challenge signature against the REGISTERED root.
 *
 * @param envelope - Challenge fields presented to the wallet.
 * @param signature - Hex signature: `personal_sign` blob for EOA roots, the
 *   Safe owner's SafeMessage signature for contract roots.
 * @param rootKey - Stored 20-byte KS256 root from public_roots.
 * @param hooks - STRICT ERC-1271 hooks (propagate
 *   {@link Erc1271UnavailableError}); when absent, contract roots cannot
 *   authenticate and fall through to (failing) EOA recovery.
 */
export async function verifyKs256ControlPlaneSignatureForRoot(
  envelope: WalletChallengeEnvelope,
  signature: string,
  rootKey: Uint8Array,
  hooks?: Ks256VerifyHooks,
): Promise<Ks256ChallengeVerdict> {
  if (hooks) {
    let isContract: boolean;
    try {
      isContract = await hooks.hasContractCode(rootKey);
    } catch (error) {
      if (error instanceof Erc1271UnavailableError) return "unavailable";
      throw error;
    }
    if (isContract) {
      const message = buildKs256ControlPlaneMessage(envelope);
      const digest = hexToBytes(hashMessage(message));
      let signatureBytes: Uint8Array;
      try {
        signatureBytes = hexToBytes(signature as `0x${string}`);
      } catch {
        return "invalid_signature";
      }
      try {
        return (await hooks.isValidSignature(rootKey, digest, signatureBytes))
          ? "valid"
          : "signer_mismatch";
      } catch (error) {
        if (error instanceof Erc1271UnavailableError) return "unavailable";
        throw error;
      }
    }
  }

  const recovered = await verifyKs256ControlPlaneSignature(envelope, signature);
  if (!recovered) return "invalid_signature";
  return ks256AddressMatchesRoot(recovered, rootKey)
    ? "valid"
    : "signer_mismatch";
}
