/**
 * Subplan 08 step 8.3: Bootstrap public key for verification.
 * Fetches from delegation-signer GET /api/public-key/:bootstrap (or config override).
 * Verifies bootstrap transparent statement (COSE Sign1) signed with secp256k1.
 */

import {
  decodeCoseSign1,
  encodeCborBstr,
  encodeSigStructure,
} from "@canopy/encoding";

export interface BootstrapPublicKeyEnv {
  delegationSignerUrl: string;
  /** Optional: use this token for unauthenticated public-key fetch. */
  delegationSignerPublicKeyToken?: string;
}

export interface BootstrapPublicKeyResult {
  /** Raw public key bytes (e.g. 33 for compressed secp256k1). */
  publicKeyBytes: Uint8Array;
}

/** Cache for a single request (no cross-request cache in Workers; caller may cache in env). */
let cachedKey: BootstrapPublicKeyResult | null = null;

/**
 * Fetch bootstrap public key from delegation-signer. Caches in process for same isolate.
 */
export async function getBootstrapPublicKey(
  env: BootstrapPublicKeyEnv,
): Promise<BootstrapPublicKeyResult> {
  if (cachedKey) return cachedKey;

  const base = env.delegationSignerUrl?.trim().replace(/\/$/, "");
  if (!base) {
    throw new Error("DELEGATION_SIGNER_URL not configured");
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (env.delegationSignerPublicKeyToken) {
    headers.Authorization = `Bearer ${env.delegationSignerPublicKeyToken}`;
  }

  const res = await fetch(`${base}/api/public-key/:bootstrap`, { headers });
  if (!res.ok) {
    throw new Error(
      `Bootstrap public key fetch failed: ${res.status} ${await res.text()}`,
    );
  }

  const data = (await res.json()) as {
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
    cachedKey = { publicKeyBytes: bytes };
    return cachedKey;
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
    cachedKey = { publicKeyBytes: bytes };
    return cachedKey;
  }
  throw new Error("Bootstrap public key response missing publicKey or x,y");
}

/**
 * Verify secp256k1 signature (raw r||s 64 bytes) over digest (32 bytes) with public key.
 * Uses viem's recoverPublicKey (secp256k1); tries recovery byte 0 and 1.
 */
export async function verifyBootstrapSignature(
  digestSha256: Uint8Array,
  signatureRaw: Uint8Array,
  publicKeyBytes: Uint8Array,
): Promise<boolean> {
  if (digestSha256.length !== 32 || signatureRaw.length !== 64) {
    return false;
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
 * Verify bootstrap transparent statement (COSE Sign1) with secp256k1 public key.
 * Builds Sig_structure (ToBeSigned), hashes it, verifies signature.
 */
export async function verifyBootstrapCoseSign1(
  coseSign1Bytes: Uint8Array,
  publicKeyBytes: Uint8Array,
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
  );
}
