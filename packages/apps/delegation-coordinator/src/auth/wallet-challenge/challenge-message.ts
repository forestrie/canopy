/**
 * Canonical UTF-8 challenge message for wallet-challenge (wcc-1).
 *
 * Signed by KS256 personal_sign or ES256 WebCrypto verify paths in session
 * exchange. Format is alg-agnostic for both signer types.
 */

import type { WalletChallengeEnvelope } from "../../types/wallet-challenge.js";

/**
 * Build the canonical UTF-8 message for KS256 personal_sign (wcc-1).
 *
 * @param envelope - Challenge fields presented to the wallet.
 * @returns Multi-line string the wallet signs.
 */
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
