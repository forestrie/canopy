/**
 * Cryptographic verification of COSE Sign1 (statement).
 * Supports ES256 (P-256 via Web Crypto). KS256 (-65799) verification lives in
 * canopy-api/arbor paths (Keccak + ecrecover / ERC-1271), not this module.
 */

import {
  decodeCborDeterministic,
  decodeCborUnwrapCose,
} from "./decode-cbor-deterministic.js";
import { encodeSigStructure } from "./encode-sig-structure.js";

/** COSE algorithm identifiers (RFC 9053). */
export const COSE_ALG_ES256 = -7;
/** KS256: secp256k1 + Keccak-256 + Ethereum address (COSE private use). */
export const COSE_ALG_KS256 = -65799;

/** Supported COSE algorithms for ES256 delegate-key verification in this module. */
export type CoseAlgorithm = "ES256";

/** Parsed EC public key coordinates for verification without a CryptoKey. */
export interface ParsedEcPublicKey {
  /** X coordinate (32 bytes). */
  x: Uint8Array;
  /** Y coordinate (32 bytes). */
  y: Uint8Array;
  /** Curve name. */
  curve: "P-256";
}

/** Verify key accepted by {@link verifyCoseSign1WithParsedKey}. */
export type ParsedVerifyKey = CryptoKey | ParsedEcPublicKey;

/** Optional structured logging when verification fails (no secrets logged). */
export interface VerifyCoseSign1Options {
  /** When true, emit JSON warning lines on failure paths. */
  logFailures?: boolean;
  /** Included in JSON log lines under `prefix`. */
  logPrefix?: string;
  /**
   * Payload bytes for detached-content verification. When the COSE Sign1 has a
   * nil/detached payload but the signature was computed over the real content,
   * supply the original payload here. It replaces the empty bstr in the
   * Sig_structure so the signature can be verified.
   */
  detachedPayload?: Uint8Array;
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
 *
 * @param protectedBstr - Decoded COSE Sign1 `[0]` protected header contents
 * @returns Numeric COSE algorithm id, or null when missing or unparseable
 */
export function extractAlgFromProtected(
  protectedBstr: Uint8Array,
): number | null {
  if (protectedBstr.length === 0) return null;
  try {
    const map = decodeCborDeterministic(protectedBstr) as unknown;
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
 * Map COSE algorithm number to Web Crypto curve name (ES256 only here).
 *
 * @param alg - COSE `alg` header value
 * @returns `"P-256"` for ES256, otherwise null
 */
export function algToCurve(alg: number): "P-256" | null {
  if (alg === COSE_ALG_ES256) return "P-256";
  return null;
}

/**
 * Verify COSE Sign1 signature with a Web Crypto public key (ES256).
 * Builds Sig_structure per RFC 8152; signature must be IEEE P1363 R‖S (64 bytes).
 *
 * @param coseSign1Bytes - CBOR COSE Sign1 tuple
 * @param publicKey - P-256 verify key
 * @param opts - Optional detached payload and failure logging
 * @returns True when signature verifies; false on any malformed input
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

  const effectivePayload = opts?.detachedPayload ?? payloadBstr;
  const externalAad = new Uint8Array(0);
  const sigStructure = encodeSigStructure(
    protectedBstr,
    externalAad,
    effectivePayload,
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
 * Verify COSE Sign1 with a {@link ParsedVerifyKey} (CryptoKey or raw P-256 coords).
 *
 * @param coseSign1Bytes - CBOR COSE Sign1 tuple
 * @param verifyKey - Web Crypto key or parsed coordinates
 * @param opts - Optional detached payload and failure logging
 * @returns True when signature verifies; false on any malformed input
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

  const effectivePayload = opts?.detachedPayload ?? payloadBstr;
  const externalAad = new Uint8Array(0);
  const sigStructure = encodeSigStructure(
    protectedBstr,
    externalAad,
    effectivePayload,
  );

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

/** Parsed components of a COSE Sign1 four-tuple after CBOR decode. */
export interface DecodedCoseSign1 {
  /** COSE Sign1 `[0]` protected header bstr (map bytes inside). */
  protectedBstr: Uint8Array;
  /** COSE Sign1 `[1]` unprotected header (Map or cbor-x object shape). */
  unprotected: unknown;
  /** COSE Sign1 `[2]` payload bstr (empty when detached). */
  payloadBstr: Uint8Array;
  /** COSE Sign1 `[3]` signature bstr. */
  signature: Uint8Array;
}

/**
 * Decode COSE Sign1 bytes to components.
 *
 * @param coseSign1Bytes - CBOR-encoded COSE Sign1
 * @returns Parsed tuple fields, or null when CBOR shape is invalid
 */
export function decodeCoseSign1(
  coseSign1Bytes: Uint8Array,
): DecodedCoseSign1 | null {
  let arr: unknown[];
  try {
    arr = decodeCborUnwrapCose(coseSign1Bytes) as unknown[];
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length < 4) return null;

  const protectedBstr = arr[0];
  const payloadRaw = arr[2];
  const sig = arr[3];

  if (!(protectedBstr instanceof Uint8Array)) return null;
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
