import { buildControlPlaneMessage } from "./challenge-message.js";
import type { WalletChallengeEnvelope } from "../../types/wallet-challenge.js";
import { base64ToBytes } from "../../encoding.js";

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function uncompressedP256PublicKey(x: Uint8Array, y: Uint8Array): Uint8Array {
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(x, 1);
  out.set(y, 33);
  return out;
}

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
 * `signatureB64` is base64 WebCrypto ECDSA output (IEEE P1363 r||s or DER).
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
