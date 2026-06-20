/**
 * KS256 register-statement Sign1 builder for unit tests (mirrors e2e helper).
 */

import {
  encodeCoseProtectedMapBytes,
  encodeCoseSign1Statement,
  encodeSigStructure,
} from "@canopy/encoding";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";

const KS256_EOA_SIG_BYTES = 65;

function addressFromUncompressedPubkey(uncompressed: Uint8Array): Uint8Array {
  const hash = keccak_256(uncompressed.slice(1));
  return hash.slice(-20);
}

function ks256AddressFromPrivateKeyHex(privateKeyHex: string): Uint8Array {
  const sk = hexToBytes(privateKeyHex.replace(/^0x/, "").trim());
  const pub = secp256k1.getPublicKey(sk, false);
  return addressFromUncompressedPubkey(pub);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function signKeccak256Ethereum(
  hash: Uint8Array,
  privateKeyHex: string,
  expectedAddress20: Uint8Array,
): Uint8Array {
  const sk = hexToBytes(privateKeyHex.replace(/^0x/, "").trim());
  const sigObj = secp256k1.sign(hash, sk, { lowS: true });
  const compact = sigObj.toCompactRawBytes();
  const preferred = sigObj.recovery ?? 0;

  const tryRecovery = (recovery: number): Uint8Array | null => {
    if (recovery < 0 || recovery > 3) return null;
    try {
      const sig =
        secp256k1.Signature.fromCompact(compact).addRecoveryBit(recovery);
      const pub = sig.recoverPublicKey(hash);
      const addr = addressFromUncompressedPubkey(pub.toRawBytes(false));
      if (!bytesEqual(addr, expectedAddress20)) return null;
      const signature = new Uint8Array(KS256_EOA_SIG_BYTES);
      signature.set(compact, 0);
      signature[64] = recovery;
      return signature;
    } catch {
      return null;
    }
  };

  const primary = tryRecovery(preferred);
  if (primary) return primary;
  for (let recovery = 0; recovery < 4; recovery++) {
    if (recovery === preferred) continue;
    const candidate = tryRecovery(recovery);
    if (candidate) return candidate;
  }
  throw new Error("KS256 statement signature: no recovery id matches address");
}

/** Fixed test wallet (deterministic golden vectors). */
export const KS256_STATEMENT_TEST_KEY_HEX =
  "0000000000000000000000000000000000000000000000000000000000000001";

export function ks256StatementTestAddress(): Uint8Array {
  return ks256AddressFromPrivateKeyHex(KS256_STATEMENT_TEST_KEY_HEX);
}

export function signKs256StatementForTest(
  payload: Uint8Array,
  privateKeyHex: string = KS256_STATEMENT_TEST_KEY_HEX,
): Uint8Array {
  const address = ks256AddressFromPrivateKeyHex(privateKeyHex);
  const protectedMapBytes = encodeCoseProtectedMapBytes(address);
  const sigStructure = encodeSigStructure(
    protectedMapBytes,
    new Uint8Array(0),
    payload,
  );
  const hash = keccak_256(sigStructure);
  const signature = signKeccak256Ethereum(hash, privateKeyHex, address);
  return encodeCoseSign1Statement(payload, address, signature);
}

export function randomKs256PrivateKeyHex(): string {
  const sk = secp256k1.utils.randomPrivateKey();
  return Array.from(sk, (b) => b.toString(16).padStart(2, "0")).join("");
}
