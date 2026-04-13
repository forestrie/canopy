/**
 * Cryptographic verification of COSE Sign1 (statement).
 * Supports ES256 (P-256 via Web Crypto) and ES256K (secp256k1 via @noble/curves).
 */

import { decode as decodeCbor } from "cbor-x";
import { secp256k1 } from "@noble/curves/secp256k1";
import { encodeSigStructure } from "./encode-sig-structure.js";

/** COSE algorithm identifiers (RFC 9053). */
export const COSE_ALG_ES256 = -7;
export const COSE_ALG_ES256K = -47;

/** Supported COSE algorithms. */
export type CoseAlgorithm = "ES256" | "ES256K";

/** Parsed EC public key for multi-curve verification. */
export interface ParsedEcPublicKey {
  /** X coordinate (32 bytes). */
  x: Uint8Array;
  /** Y coordinate (32 bytes). */
  y: Uint8Array;
  /** Curve name. */
  curve: "P-256" | "secp256k1";
}

/** Verify key: either Web Crypto CryptoKey (P-256) or parsed coordinates (secp256k1). */
export type ParsedVerifyKey = CryptoKey | ParsedEcPublicKey;

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
 * Extract the `alg` value from COSE protected header bytes.
 * Returns the numeric algorithm identifier or null if not found.
 */
export function extractAlgFromProtected(
  protectedBstr: Uint8Array,
): number | null {
  if (protectedBstr.length === 0) return null;
  try {
    const map = decodeCbor(protectedBstr) as unknown;
    if (map instanceof Map) {
      const alg = map.get(1);
      if (typeof alg === "number") return alg;
      if (typeof alg === "bigint") return Number(alg);
    } else if (typeof map === "object" && map !== null) {
      const obj = map as Record<string | number, unknown>;
      const alg = obj[1] ?? obj["1"];
      if (typeof alg === "number") return alg;
      if (typeof alg === "bigint") return Number(alg);
    }
  } catch {
    // Invalid CBOR
  }
  return null;
}

/**
 * Map COSE algorithm number to curve name.
 */
export function algToCurve(alg: number): "P-256" | "secp256k1" | null {
  if (alg === COSE_ALG_ES256) return "P-256";
  if (alg === COSE_ALG_ES256K) return "secp256k1";
  return null;
}

/**
 * Verify a secp256k1 (ES256K) signature using @noble/curves.
 */
async function verifySecp256k1Signature(
  sigStructure: Uint8Array,
  signature: Uint8Array,
  pubKey: ParsedEcPublicKey,
): Promise<boolean> {
  if (signature.length !== 64) return false;

  // Hash the Sig_structure
  const msgHash = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(sigStructure),
  );
  const msgHashBytes = new Uint8Array(msgHash);

  // Build uncompressed public key: 04 || x || y
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(pubKey.x, 1);
  uncompressed.set(pubKey.y, 33);

  try {
    return secp256k1.verify(signature, msgHashBytes, uncompressed);
  } catch {
    return false;
  }
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

/**
 * Verify COSE Sign1 signature using a parsed verify key (supports both curves).
 * Extracts `alg` from the protected header and routes to the appropriate verifier.
 *
 * @param coseSign1Bytes - Full COSE Sign1 CBOR bytes
 * @param verifyKey - ParsedVerifyKey (CryptoKey for P-256, or ParsedEcPublicKey for secp256k1)
 * @returns true if signature is valid
 */
export async function verifyCoseSign1WithParsedKey(
  coseSign1Bytes: Uint8Array,
  verifyKey: ParsedVerifyKey,
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

  const externalAad = new Uint8Array(0);
  const sigStructure = encodeSigStructure(
    protectedBstr,
    externalAad,
    payloadBstr,
  );

  // Determine curve from key type
  const isSecp256k1 =
    !(verifyKey instanceof CryptoKey) && verifyKey.curve === "secp256k1";

  if (isSecp256k1) {
    const ok = await verifySecp256k1Signature(
      sigStructure,
      signature,
      verifyKey as ParsedEcPublicKey,
    );
    if (!ok) {
      logVerifyFailure(opts, "secp256k1_verify_false", {
        protectedBstrLen: protectedBstr.length,
        payloadBstrLen: payloadBstr.length,
        sigStructureLen: sigStructure.length,
        sigStructureSha256HexPrefix: await sha256HexPrefix16(sigStructure),
        signatureHeadHex: hexPreview(signature, 8),
      });
    }
    return ok;
  }

  // P-256 path via Web Crypto
  if (verifyKey instanceof CryptoKey) {
    try {
      const ok = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verifyKey,
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

  // P-256 with parsed key - import to CryptoKey first
  const parsed = verifyKey as ParsedEcPublicKey;
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(parsed.x, 1);
  uncompressed.set(parsed.y, 33);

  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      uncompressed,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
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
    logVerifyFailure(opts, "p256_parsed_verify_threw", {
      error: e instanceof Error ? e.message : String(e),
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
  const payloadRaw = arr[2];
  const sig = arr[3];

  if (!(protectedBstr instanceof Uint8Array)) return null;
  /** COSE detached content: payload is null/nil; Sig_structure uses empty bstr (RFC 8152). */
  const payloadBstr =
    payloadRaw === null || payloadRaw === undefined
      ? new Uint8Array(0)
      : payloadRaw instanceof Uint8Array
        ? payloadRaw
        : null;
  if (payloadBstr === null) return null;
  if (!(sig instanceof Uint8Array)) return null;

  return {
    protectedBstr,
    unprotected: arr[1],
    payloadBstr,
    signature: sig,
  };
}
