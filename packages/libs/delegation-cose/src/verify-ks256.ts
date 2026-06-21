import { encodeSigStructure } from "@canopy/encoding";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesEqual } from "./bytes-utils.js";
import type { Ks256VerifyHooks } from "./ks256-verify-hooks.js";
import { decodeCoseSign1Parts } from "./parse-delegated-cose-key.js";
import { KS256_EOA_SIG_BYTES } from "./payload-labels.js";

function addressFromUncompressedPubkey(uncompressed: Uint8Array): Uint8Array {
  const hash = keccak_256(uncompressed.slice(1));
  return hash.slice(-20);
}

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
