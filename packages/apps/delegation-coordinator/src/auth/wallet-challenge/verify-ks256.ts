/**
 * KS256 personal_sign recovery for wcc-1 control-plane challenges.
 *
 * Recovered address is matched against stored KS256 public root per
 * [univocity docs/arc](https://github.com/forestrie/univocity/blob/main/docs/arc/).
 */

import { recoverMessageAddress } from "viem";
import { buildKs256ControlPlaneMessage } from "./challenge-message.js";
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
