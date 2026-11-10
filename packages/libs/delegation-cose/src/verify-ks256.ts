/**
 * KS256 delegation certificate verification. Digest is keccak256(Sig_structure);
 * EOA roots recover the signer address from `r‖s‖v`. Contract roots delegate
 * to ERC-1271 via optional hooks (delegation-coordinator RPC) — see
 * [plan-0031 KS256 forest roots](https://github.com/forestrie/canopy/blob/main/docs/plans/plan-0031-ks256-forest-roots.md).
 */

import { bytesEqual } from "./bytes-utils.js";
import type { Ks256VerifyHooks } from "./ks256-verify-hooks.js";
import { decodeKs256Certificate } from "./decode-ks256-certificate.js";
import { recoverKs256Signer } from "./recover-ks256-signer.js";

/**
 * Verify a KS256 delegation certificate against the expected root signer
 * address.
 *
 * @param certificate - CBOR COSE_Sign1 bytes from coordinator or BYOK upload.
 * @param rootSignerAddress - 20-byte trusted root address (Univocity forest
 *   root or operator wallet).
 * @param hooks - When supplied and the root has contract code, verification
 *   uses {@link Ks256VerifyHooks.isValidSignature} (ERC-1271) instead of EOA
 *   recovery.
 * @returns `true` when the root authorized the Sig_structure digest; `false`
 *   when it did not, when an EOA root's signature is high-s, or when the
 *   certificate's protected `alg` is not KS256 or it carries a WebAuthn
 *   envelope (alg confusion, as arbor rejects it).
 */
export async function verifyDelegationCertificateKs256(
  certificate: Uint8Array,
  rootSignerAddress: Uint8Array,
  hooks?: Ks256VerifyHooks,
): Promise<boolean> {
  if (rootSignerAddress.length !== 20) {
    throw new Error("KS256 root signer address must be 20 bytes");
  }
  const decoded = decodeKs256Certificate(certificate);
  if (!decoded.ok) return false;
  const { digest: hash, signature } = decoded;

  if (hooks) {
    const isContract = await hooks.hasContractCode(rootSignerAddress);
    if (isContract) {
      return hooks.isValidSignature(rootSignerAddress, hash, signature);
    }
  }

  const recovered = recoverKs256Signer(hash, signature);
  return recovered.ok && bytesEqual(recovered.address, rootSignerAddress);
}
