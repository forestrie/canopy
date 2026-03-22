/**
 * Subplan 08 step 8.3: Bootstrap public key for verification.
 * Fetches from delegation-signer GET /api/public-key/:bootstrap.
 * Default alg is ES256 (P-256); KS256 (secp256k1) also supported.
 */

import { decodeCoseSign1, encodeSigStructure } from "@canopy/encoding";
import { p256 } from "@noble/curves/p256.js";

export type BootstrapAlg = "ES256" | "KS256";

export interface BootstrapPublicKeyEnv {
  delegationSignerUrl: string;
  /** Optional: use this token for unauthenticated public-key fetch. */
  delegationSignerPublicKeyToken?: string;
  /** Alg used for bootstrap; default ES256. */
  bootstrapAlg?: BootstrapAlg;
}

export interface BootstrapPublicKeyResult {
  /** Raw public key bytes (65 for uncompressed: 04||x||y). */
  publicKeyBytes: Uint8Array;
  alg: BootstrapAlg;
}

/** Per-alg cache: parallel ES256/KS256 fetches must not clobber each other (e.g. Playwright workers). */
const bootstrapPublicKeyByAlg = new Map<
  BootstrapAlg,
  BootstrapPublicKeyResult
>();

/**
 * Extract 65-byte uncompressed EC public key (04||x||y) from SPKI DER.
 * Matches common SPKI for P-256 and secp256k1: BIT STRING tag 0x03, length 66,
 * content 0x00 (unused bits) + 65-byte uncompressed point.
 */
function extractUncompressed65FromEcSpkiDer(der: Uint8Array): Uint8Array {
  // Need index i where subarray(i+3, i+68) fits: i + 68 <= der.length → i <= der.length - 68
  for (let i = 0; i <= der.length - 68; i++) {
    if (
      der[i] === 0x03 &&
      der[i + 1] === 66 &&
      der[i + 2] === 0x00 &&
      der[i + 3] === 0x04
    ) {
      const key = new Uint8Array(65);
      key.set(der.subarray(i + 3, i + 68));
      return key;
    }
  }
  throw new Error("SPKI DER missing uncompressed EC BIT STRING (66 bytes)");
}

function pemBodyToDer(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(base64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der;
}

/**
 * Decode PEM SPKI to raw uncompressed public key (65 bytes: 04||x||y).
 * Uses DER walk (not Web Crypto SPKI import) so Workers accept the same PEM as
 * delegation-signer (P-256 and secp256k1 share this BIT STRING layout).
 */
function publicKeyBytesFromPem(pem: string): Uint8Array {
  return extractUncompressed65FromEcSpkiDer(pemBodyToDer(pem));
}

/**
 * Fetch bootstrap public key from delegation-signer. Default alg=ES256.
 * Caches per alg in process for same isolate.
 */
export async function getBootstrapPublicKey(
  env: BootstrapPublicKeyEnv,
): Promise<BootstrapPublicKeyResult> {
  const alg = env.bootstrapAlg ?? "ES256";
  const cached = bootstrapPublicKeyByAlg.get(alg);
  if (cached) return cached;

  const base = env.delegationSignerUrl?.trim().replace(/\/$/, "");
  if (!base) {
    throw new Error("DELEGATION_SIGNER_URL not configured");
  }

  const headers: Record<string, string> = {};
  if (env.delegationSignerPublicKeyToken) {
    headers.Authorization = `Bearer ${env.delegationSignerPublicKeyToken}`;
  }

  const res = await fetch(`${base}/api/public-key/:bootstrap?alg=${alg}`, {
    headers,
  });
  if (!res.ok) {
    throw new Error(
      `Bootstrap public key fetch failed: ${res.status} ${await res.text()}`,
    );
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const body = await res.text();
  if (
    contentType.includes("application/x-pem-file") ||
    body.trim().startsWith("-----BEGIN ")
  ) {
    const publicKeyBytes = publicKeyBytesFromPem(body);
    const result: BootstrapPublicKeyResult = { publicKeyBytes, alg };
    bootstrapPublicKeyByAlg.set(alg, result);
    return result;
  }

  const data = JSON.parse(body) as {
    publicKey?: string;
    x?: string;
    y?: string;
  };
  if (data.publicKey) {
    const hex = data.publicKey.replace(/^0x/i, "").trim();
    if (hex.length % 2 !== 0) throw new Error("Invalid publicKey hex length");
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    const result = { publicKeyBytes: bytes, alg } as BootstrapPublicKeyResult;
    bootstrapPublicKeyByAlg.set(alg, result);
    return result;
  }
  if (typeof data.x === "string" && typeof data.y === "string") {
    const xHex = data.x.replace(/^0x/i, "").trim();
    const yHex = data.y.replace(/^0x/i, "").trim();
    if (xHex.length !== 64 || yHex.length !== 64) {
      throw new Error("Invalid x/y length for uncompressed key");
    }
    const bytes = new Uint8Array(65);
    bytes[0] = 0x04;
    for (let i = 0; i < 32; i++) {
      bytes[1 + i] = parseInt(xHex.slice(i * 2, i * 2 + 2), 16);
      bytes[33 + i] = parseInt(yHex.slice(i * 2, i * 2 + 2), 16);
    }
    const result = { publicKeyBytes: bytes, alg } as BootstrapPublicKeyResult;
    bootstrapPublicKeyByAlg.set(alg, result);
    return result;
  }
  throw new Error("Bootstrap public key response missing publicKey or x,y");
}

/**
 * Verify bootstrap signature (raw r||s 64 bytes) over digest (32 bytes).
 * ES256: Web Crypto ECDSA P-256; KS256: viem recoverPublicKey (secp256k1).
 */
export async function verifyBootstrapSignature(
  digestSha256: Uint8Array,
  signatureRaw: Uint8Array,
  publicKeyBytes: Uint8Array,
  alg: BootstrapAlg,
): Promise<boolean> {
  if (digestSha256.length !== 32 || signatureRaw.length !== 64) {
    return false;
  }
  if (alg === "ES256") {
    // Match delegation-signer (p256.sign with prehash: true). After fixing
    // Sig_structure, Web Crypto can still reject some valid signatures (high-S);
    // noble verify matches the signer.
    try {
      return p256.verify(signatureRaw, digestSha256, publicKeyBytes, {
        prehash: true,
      });
    } catch {
      return false;
    }
  }
  const hashHex =
    "0x" +
    Array.from(digestSha256)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const expectedPubHex =
    "0x" +
    Array.from(publicKeyBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const { recoverPublicKey } = await import("viem");
  for (const recoveryByte of [0, 1]) {
    const sig65 = new Uint8Array(65);
    sig65.set(signatureRaw, 0);
    sig65[64] = recoveryByte;
    const sigHex =
      "0x" +
      Array.from(sig65)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    try {
      const recovered = await recoverPublicKey({
        hash: hashHex as `0x${string}`,
        signature: sigHex as `0x${string}`,
      });
      if (recovered.toLowerCase() === expectedPubHex.toLowerCase()) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Verify bootstrap transparent statement (COSE Sign1) with public key (ES256 or KS256).
 */
export async function verifyBootstrapCoseSign1(
  coseSign1Bytes: Uint8Array,
  publicKeyBytes: Uint8Array,
  alg: BootstrapAlg,
): Promise<boolean> {
  const decoded = decodeCoseSign1(coseSign1Bytes);
  if (!decoded) return false;
  const { protectedBstr, payloadBstr, signature } = decoded;
  const externalAad = new Uint8Array(0);
  // Same as bootstrap-grant: encodeSigStructure wraps protected (raw map bytes, e.g. 0xa0).
  // Do not pre-encode protected with encodeCborBstr — that would double-wrap vs mint.
  const sigStructure = encodeSigStructure(
    protectedBstr,
    externalAad,
    payloadBstr,
  );
  const digest = await crypto.subtle.digest("SHA-256", sigStructure);
  return verifyBootstrapSignature(
    new Uint8Array(digest),
    signature,
    publicKeyBytes,
    alg,
  );
}
