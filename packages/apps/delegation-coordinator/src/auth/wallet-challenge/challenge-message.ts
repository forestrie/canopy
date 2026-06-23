import type { WalletChallengeEnvelope } from "../../types/wallet-challenge.js";

/** Canonical UTF-8 message for KS256 personal_sign (wcc-1). */
export function buildKs256ControlPlaneMessage(
  envelope: WalletChallengeEnvelope,
): string {
  const scopes = envelope.scopes.join(" ");
  const chainLine =
    envelope.chainId !== undefined ? `Chain ID: ${envelope.chainId}\n` : "";
  return [
    `${envelope.domain} wants you to authorize delegation control-plane access:`,
    `Auth log: ${envelope.authLogId}`,
    `Scopes: ${scopes}`,
    `Nonce: ${envelope.nonce}`,
    `Issued At: ${envelope.issuedAt}`,
    `Expiration Time: ${envelope.expiresAt}`,
    chainLine.trimEnd(),
    `Coordinator: ${envelope.coordinatorOrigin}`,
    `Version: ${envelope.version}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Alg-agnostic alias for wcc-1 challenge text (KS256 and ES256). */
export const buildControlPlaneMessage = buildKs256ControlPlaneMessage;
