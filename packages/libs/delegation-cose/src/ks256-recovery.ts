/**
 * Result of recovering a KS256 EOA signer: the recovered 20-byte address, or
 * why there is none. A recovered address still has to be compared with the
 * expected signer.
 */
export type Ks256Recovery =
  | { ok: true; address: Uint8Array }
  | { ok: false; reason: Ks256RecoveryFailure };

/**
 * Why a KS256 EOA signature recovered no signer:
 * - `signature_wrong_length`: not 65 bytes `r‖s‖v`;
 * - `signature_high_s`: `s > (n-1)/2`, the malleated twin of a valid
 *   signature, refused before recovery;
 * - `recovery_failed`: `r`, `s` or `v` out of range, or no point recovers.
 */
export type Ks256RecoveryFailure =
  | "signature_wrong_length"
  | "signature_high_s"
  | "recovery_failed";
