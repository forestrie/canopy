/**
 * KS256 EOA signer recovery, shared by this package's delegation
 * certificate and on-chain delegation checks and by canopy-api's COSE_Sign1
 * and onboarding attestation checks. grant-builder, which does not depend on
 * this package, applies the same bound in `verifyKs256GrantStatement`. A
 * recovered KS256 signature must be low-s, the rule
 * [checkpoints-and-receipts.md](https://github.com/forestrie/protocol/blob/main/spec/checkpoints-and-receipts.md)
 * sets for every KS256 verifier, checked against the shared vector
 * `vectors/fixtures/ks256-low-s.json` in
 * [forestrie/protocol](https://github.com/forestrie/protocol/blob/main/vectors/README.md).
 * arbor applies the same bound, and so does univocity's `verifyKS256Raw` from
 * the contract release that adds it; instances deployed before that release
 * still accept high-s.
 *
 * A contract (ERC-1271) root judges its own signature. Callers with hooks
 * send it there before recovery; a caller that recovers first (no hooks, or
 * an offline verifier) simply fails to recover a contract root's signature.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import type { Ks256Recovery } from "./ks256-recovery.js";
import { KS256_EOA_SIG_BYTES } from "./payload-labels.js";

/**
 * Recover the EOA that signed a KS256 digest.
 *
 * Recovery alone accepts both `s` and `n − s`, so anyone holding one valid
 * signature could make a second; a high-s signature is refused before
 * recovery.
 *
 * @param digest - 32-byte keccak256(Sig_structure).
 * @param signature - 65-byte `r‖s‖v`; `v` is the recovery id, as 0–3 or
 *   27–30.
 */
export function recoverKs256Signer(
  digest: Uint8Array,
  signature: Uint8Array,
): Ks256Recovery {
  if (signature.length !== KS256_EOA_SIG_BYTES) {
    return { ok: false, reason: "signature_wrong_length" };
  }
  let v = signature[64]!;
  if (v >= 27) v -= 27;
  if (v > 3) return { ok: false, reason: "recovery_failed" };
  try {
    const sig = secp256k1.Signature.fromCompact(signature.slice(0, 64));
    if (sig.hasHighS()) return { ok: false, reason: "signature_high_s" };
    const pub = sig.addRecoveryBit(v).recoverPublicKey(digest);
    return {
      ok: true,
      address: addressFromUncompressedPubkey(pub.toRawBytes(false)),
    };
  } catch {
    return { ok: false, reason: "recovery_failed" };
  }
}

/**
 * Derive a 20-byte Ethereum address from an uncompressed secp256k1 public key.
 *
 * @param uncompressed - 65-byte `0x04‖x‖y` point encoding.
 */
function addressFromUncompressedPubkey(uncompressed: Uint8Array): Uint8Array {
  return keccak_256(uncompressed.slice(1)).slice(-20);
}
