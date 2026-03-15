/**
 * Subplan 08 step 8.3: Bootstrap public key for verification.
 * Fetches from delegation-signer GET /api/public-key/:bootstrap.
 * Default alg is ES256 (P-256); KS256 (secp256k1) also supported.
 */

import {
  decodeCoseSign1,
  encodeCborBstr,
  encodeSigStructure,
} from "@canopy/encoding";

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

let cachedResult: { result: BootstrapPublicKeyResult; alg: BootstrapAlg } | null = null;

/**
 * Extract 65-byte uncompressed secp256k1 public key (04||x||y) from SPKI DER.
 * SPKI BIT STRING content is 0x00 (unused bits) + 65-byte key.
 */
function extractSecp256k1FromSpkiDer(der: Uint8Array): Uint8Array {
  // Find BIT STRING (0x03) with length 66 (0x00 + 65-byte key)
  for (let i = 0; i < der.length - 68; i++) {
    if (der[i] === 0x03 && der[i + 1] === 66 && der[i + 2] === 0x00 && der[i + 3] === 0x04) {
      const key = new Uint8Array(65);
      key.set(der.subarray(i + 3, i + 68));
      return key;
    }
  }
  throw new Error("SPKI DER missing secp256k1 BIT STRING (66 bytes)");
}

/**
 * Decode PEM to raw 65-byte uncompressed key (04||x||y). Works for both P-256 and secp256k1 SPKI.
 */
function pemToUncompressed65(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(base64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return extractSecp256k1FromSpkiDer(der);
}

/**
 * Fetch bootstrap public key from delegation-signer. Default alg=ES256.
 * Caches per alg in process for same isolate.
 */
export async function getBootstrapPublicKey(
  env: BootstrapPublicKeyEnv,
): Promise<BootstrapPublicKeyResult> {
  const alg = env.bootstrapAlg ?? "ES256";
  if (cachedResult && cachedResult.alg === alg) return cachedResult.result;

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
    const result: BootstrapPublicKeyResult = {
      publicKeyBytes: pemToUncompressed65(body),
      alg,
    };
    cachedResult = { result, alg };
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
    cachedResult = { result, alg };
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
    cachedResult = { result, alg };
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
    const key = await crypto.subtle.importKey(
      "raw",
      publicKeyBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signatureRaw,
      digestSha256,
    );
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
  const protectedBstrForSig = encodeCborBstr(protectedBstr);
  const externalAad = new Uint8Array(0);
  const sigStructure = encodeSigStructure(
    protectedBstrForSig,
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
