/**
 * ES256 WebCrypto verification for wcc-1 control-plane challenge messages.
 *
 * Complements KS256 personal_sign recovery in verify-ks256.ts during session
 * exchange.
 */

import { buildControlPlaneMessage } from "./challenge-message.js";
import type { WalletChallengeEnvelope } from "../../types/wallet-challenge.js";
import { base64ToBytes } from "../../encoding.js";

/** Copy Uint8Array to ArrayBuffer for WebCrypto import/verify. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** Build uncompressed P-256 point 0x04||x||y for raw key import. */
function uncompressedP256PublicKey(x: Uint8Array, y: Uint8Array): Uint8Array {
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(x, 1);
  out.set(y, 33);
  return out;
}

/** Import raw uncompressed P-256 public key for verify. */
async function importEs256PublicKey(
  x: Uint8Array,
  y: Uint8Array,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(uncompressedP256PublicKey(x, y)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

/**
 * Verify ES256 control-plane signature over wcc-1 UTF-8 message.
 *
 * @param envelope - Challenge envelope signed by the wallet.
 * @param signatureB64 - Base64 WebCrypto ECDSA signature (IEEE P1363 or DER).
 * @param publicKeyX - Signer P-256 x coordinate (32 bytes).
 * @param publicKeyY - Signer P-256 y coordinate (32 bytes).
 * @returns True when signature verifies over {@link buildControlPlaneMessage}.
 */
export async function verifyEs256ControlPlaneSignature(
  envelope: WalletChallengeEnvelope,
  signatureB64: string,
  publicKeyX: Uint8Array,
  publicKeyY: Uint8Array,
): Promise<boolean> {
  if (publicKeyX.length !== 32 || publicKeyY.length !== 32) {
    return false;
  }
  const message = buildControlPlaneMessage(envelope);
  const messageBytes = new TextEncoder().encode(message);
  let signature: Uint8Array;
  try {
    signature = base64ToBytes(signatureB64);
  } catch {
    return false;
  }
  if (signature.length === 0) return false;

  const publicKey = await importEs256PublicKey(publicKeyX, publicKeyY);
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    toArrayBuffer(signature),
    messageBytes,
  );
}
