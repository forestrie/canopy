/**
 * KS256 delegation certificate verification. Digest is keccak256(Sig_structure);
 * EOA roots recover the signer address from `r‖s‖v`. Contract roots delegate
 * to ERC-1271 via optional hooks (delegation-coordinator RPC) — see
 * [plan-0031 KS256 forest roots](https://github.com/forestrie/canopy/blob/main/docs/plans/plan-0031-ks256-forest-roots.md).
 */

import { encodeSigStructure } from "./encode-sig-structure.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesEqual } from "./bytes-utils.js";
import type { Ks256VerifyHooks } from "./ks256-verify-hooks.js";
import { decodeCoseSign1Parts } from "./parse-delegated-cose-key.js";
import { KS256_EOA_SIG_BYTES } from "./payload-labels.js";

/**
 * Derive a 20-byte Ethereum address from an uncompressed secp256k1 public key.
 *
 * @param uncompressed - 65-byte `0x04‖x‖y` point encoding.
 */
function addressFromUncompressedPubkey(uncompressed: Uint8Array): Uint8Array {
  const hash = keccak_256(uncompressed.slice(1));
  return hash.slice(-20);
}

/**
 * Recover the EOA signer address from a KS256 signature over a message hash.
 *
 * @param hash - 32-byte keccak256 digest of Sig_structure.
 * @param signature - 65-byte `r‖s‖v` signature.
 * @returns Recovered address or `null` when recovery fails.
 */
function recoverSignerAddress(
  hash: Uint8Array,
  signature: Uint8Array,
): Uint8Array | null {
  if (signature.length !== KS256_EOA_SIG_BYTES) return null;
  const r = signature.slice(0, 32);
  const s = signature.slice(32, 64);
  let v = signature[64]!;
  if (v >= 27) v -= 27;
  const recovery = v;
  if (recovery > 3) return null;
  try {
    const sig = secp256k1.Signature.fromCompact(
      new Uint8Array([...r, ...s]),
    ).addRecoveryBit(recovery);
    const pub = sig.recoverPublicKey(hash);
    return addressFromUncompressedPubkey(pub.toRawBytes(false));
  } catch {
    return null;
  }
}

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
 * @returns `true` when the root authorized the Sig_structure digest.
 */
export async function verifyDelegationCertificateKs256(
  certificate: Uint8Array,
  rootSignerAddress: Uint8Array,
  hooks?: Ks256VerifyHooks,
): Promise<boolean> {
  if (rootSignerAddress.length !== 20) {
    throw new Error("KS256 root signer address must be 20 bytes");
  }
  const { protectedBytes, payloadBytes, signature } =
    decodeCoseSign1Parts(certificate);
  const sigStructureBytes = encodeSigStructure(
    protectedBytes,
    new Uint8Array(),
    payloadBytes,
  );
  const hash = keccak_256(sigStructureBytes);

  if (hooks) {
    const isContract = await hooks.hasContractCode(rootSignerAddress);
    if (isContract) {
      return hooks.isValidSignature(rootSignerAddress, hash, signature);
    }
  }

  if (signature.length !== KS256_EOA_SIG_BYTES) {
    return false;
  }
  const recovered = recoverSignerAddress(hash, signature);
  return recovered !== null && bytesEqual(recovered, rootSignerAddress);
}
