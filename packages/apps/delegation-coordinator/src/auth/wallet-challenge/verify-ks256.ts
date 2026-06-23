import { recoverMessageAddress } from "viem";
import { buildKs256ControlPlaneMessage } from "./challenge-message.js";
import type { WalletChallengeEnvelope } from "../../types/wallet-challenge.js";

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
