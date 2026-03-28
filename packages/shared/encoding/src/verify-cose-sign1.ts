/**
 * Cryptographic verification of COSE Sign1 (statement).
 * Single place for verify concern; uses Web Crypto (ES256 / P-256).
 */

import { decode as decodeCbor } from "cbor-x";
import { encodeSigStructure } from "./encode-sig-structure.js";

/** Optional structured logging when verification fails (no secrets). */
export interface VerifyCoseSign1Options {
  logFailures?: boolean;
  /** Included in JSON log lines under `prefix`. */
  logPrefix?: string;
}

function hexPreview(bytes: Uint8Array, maxBytes: number): string {
  const n = Math.min(maxBytes, bytes.length);
  let s = "";
  for (let i = 0; i < n; i++) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  if (bytes.length > n) s += "…";
  return s;
}

async function sha256HexPrefix16(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return hexPreview(new Uint8Array(d), 8);
}

function logVerifyFailure(
  opts: VerifyCoseSign1Options | undefined,
  msg: string,
  extra: Record<string, unknown>,
): void {
  if (!opts?.logFailures) return;
  console.warn(
    JSON.stringify({
      tag: "verifyCoseSign1Failure",
      prefix: opts.logPrefix ?? "",
      reason: msg,
      ...extra,
    }),
  );
}

/**
 * Verify COSE Sign1 signature with a public key (ES256).
 * Builds Sig_structure per RFC 8152 and verifies ECDSA P-256 (ES256).
 * Signature bstr must be IEEE P1363 R‖S (64 bytes); ASN.1 DER is not COSE ES256.
 *
 * @param coseSign1Bytes - Full COSE Sign1 CBOR bytes (4-element array)
 * @param publicKey - CryptoKey (EC P-256, usage verify)
 * @returns true if signature is valid
 */
export async function verifyCoseSign1(
  coseSign1Bytes: Uint8Array,
  publicKey: CryptoKey,
  opts?: VerifyCoseSign1Options,
): Promise<boolean> {
  const decoded = decodeCoseSign1(coseSign1Bytes);
  if (!decoded) {
    logVerifyFailure(opts, "decode_failed", {
      coseSign1Len: coseSign1Bytes.length,
      coseSign1HeadHex: hexPreview(coseSign1Bytes, 16),
    });
    return false;
  }

  const { protectedBstr, payloadBstr, signature } = decoded;

  if (signature.length !== 64) {
    logVerifyFailure(opts, "signature_wrong_length", {
      signatureLen: signature.length,
      signatureHeadHex: hexPreview(signature, 8),
      signatureLooksLikeASN1DER: signature.length > 0 && signature[0] === 0x30,
    });
    return false;
  }

  // Decode gives bstr *content* (serialized protected map). encodeSigStructure
  // wraps it once as body_protected — same as go-cose / Custodian.
  const externalAad = new Uint8Array(0);
  const sigStructure = encodeSigStructure(
    protectedBstr,
    externalAad,
    payloadBstr,
  );

  try {
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature as BufferSource,
      sigStructure as BufferSource,
    );
    if (!ok) {
      logVerifyFailure(opts, "ecdsa_verify_false", {
        protectedBstrLen: protectedBstr.length,
        payloadBstrLen: payloadBstr.length,
        sigStructureLen: sigStructure.length,
        sigStructureSha256HexPrefix: await sha256HexPrefix16(sigStructure),
        signatureHeadHex: hexPreview(signature, 8),
      });
    }
    return ok;
  } catch (e) {
    logVerifyFailure(opts, "subtle_verify_threw", {
      error: e instanceof Error ? e.message : String(e),
      protectedBstrLen: protectedBstr.length,
      payloadBstrLen: payloadBstr.length,
      sigStructureLen: sigStructure.length,
    });
    return false;
  }
}

export interface DecodedCoseSign1 {
  protectedBstr: Uint8Array;
  unprotected: unknown;
  payloadBstr: Uint8Array;
  signature: Uint8Array;
}

/**
 * Decode COSE Sign1 bytes to components. Returns null if malformed.
 * Signature is returned as raw bytes (for verify); caller must have received bstr in the array.
 */
export function decodeCoseSign1(
  coseSign1Bytes: Uint8Array,
): DecodedCoseSign1 | null {
  let arr: unknown[];
  try {
    arr = decodeCbor(coseSign1Bytes) as unknown[];
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length < 4) return null;

  const protectedBstr = arr[0];
  const payloadBstr = arr[2];
  const sig = arr[3];

  if (!(protectedBstr instanceof Uint8Array)) return null;
  if (!(payloadBstr instanceof Uint8Array)) return null;
  if (!(sig instanceof Uint8Array)) return null;

  return {
    protectedBstr,
    unprotected: arr[1],
    payloadBstr,
    signature: sig,
  };
}
