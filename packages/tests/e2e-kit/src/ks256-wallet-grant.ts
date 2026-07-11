/**
 * Sign a Forestrie-Grant v0 payload with a KS256 (Ethereum EOA) private key,
 * matching arbor univocity `verifyCoseSign1KS256`.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decode } from "cbor-x";
import {
  encodeCoseProtectedMapBytes,
  encodeCoseSign1Statement,
  encodeSigStructure,
} from "@forestrie/encoding";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import type { Grant } from "./wire/grant/grant.js";
import { authLogBootstrapShapedFlags } from "./wire/grant/grant-flags.js";
import { uuidToBytes } from "./wire/grant/uuid-bytes.js";
import { encodeGrantPayloadV0Canonical } from "./es256-pem-grant.js";

/** COSE protected header `{1: -65799}` (KS256), canonical wire bytes. */
export const KS256_PROTECTED_HEADER = new Uint8Array([
  0xa1, 0x01, 0x3a, 0x00, 0x01, 0x01, 0x06,
]);

const IDTIMESTAMP_BYTES = 8;
const KS256_EOA_SIG_BYTES = 65;
const CBOR_KEY_FORESTRIE_GRANT_V0 = [0x3a, 0x00, 0x01, 0x00, 0x01];
const CBOR_KEY_IDTIMESTAMP = [0x3a, 0x00, 0x01, 0x00, 0x00];

function appendCborBstr(out: number[], bytes: Uint8Array): void {
  const n = bytes.length;
  if (n < 24) out.push(0x40 | n);
  else if (n <= 0xff) out.push(0x58, n);
  else if (n <= 0xffff) out.push(0x59, (n >> 8) & 0xff, n & 0xff);
  else
    out.push(
      0x5a,
      (n >>> 24) & 0xff,
      (n >> 16) & 0xff,
      (n >> 8) & 0xff,
      n & 0xff,
    );
  for (let i = 0; i < n; i++) out.push(bytes[i]!);
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function bytesToForestrieGrantBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function parsePrivateKeyHex(raw: string): Uint8Array {
  const hex = raw.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "KS256 bootstrap private key must be 32-byte hex (64 chars)",
    );
  }
  return hexToBytes(hex);
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

function addressFromUncompressedPubkey(uncompressed: Uint8Array): Uint8Array {
  const hash = keccak_256(uncompressed.slice(1));
  return hash.slice(-20);
}

/** 20-byte Ethereum address from a secp256k1 private key. */
export function ks256AddressFromPrivateKeyHex(
  privateKeyHex: string,
): Uint8Array {
  const sk = parsePrivateKeyHex(privateKeyHex);
  const pub = secp256k1.getPublicKey(sk, false);
  return addressFromUncompressedPubkey(pub);
}

/** Ephemeral KS256 bootstrap private key hex from env file path. */
export function bootstrapKs256PrivateKeyHex(): string | undefined {
  const file = process.env.E2E_UNIVOCITY_KS256_BOOTSTRAP_KEY_FILE?.trim();
  if (!file) return undefined;
  return readFileSync(file, "utf8").trim();
}

function signKeccak256Ethereum(
  hash: Uint8Array,
  privateKeyHex: string,
  expectedAddress20: Uint8Array,
): Uint8Array {
  const sk = parsePrivateKeyHex(privateKeyHex);
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
  throw new Error(
    "KS256 grant signature: no recovery id matches bootstrap address",
  );
}

/** Sign a register-statement COSE Sign1 with KS256 (kid = 20-byte address). */
export function signKs256RootStatement(
  payload: Uint8Array,
  privateKeyHex: string,
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
  const sign1 = encodeCoseSign1Statement(payload, address, signature);
  if (!verifyKs256GrantStatement(sign1, address)) {
    throw new Error(
      "KS256 statement COSE Sign1 failed local ecrecover verification",
    );
  }
  return sign1;
}

/** Ephemeral KS256 private key hex (32 bytes) for negative-path e2e. */
export function randomKs256PrivateKeyHex(): string {
  const sk = secp256k1.utils.randomPrivateKey();
  return Array.from(sk, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sign grant v0 CBOR with KS256 EOA key; returns COSE Sign1 wire bytes. */
export function signGrantPayloadWithKs256Wallet(
  grantPayloadBytes: Uint8Array,
  privateKeyHex: string,
): Uint8Array {
  const expectedAddress = ks256AddressFromPrivateKeyHex(privateKeyHex);
  const payloadDigest = sha256(grantPayloadBytes);
  const sigStructure = encodeSigStructure(
    KS256_PROTECTED_HEADER,
    new Uint8Array(0),
    payloadDigest,
  );
  const hash = keccak_256(sigStructure);
  const signature = signKeccak256Ethereum(hash, privateKeyHex, expectedAddress);

  const out: number[] = [0x84];
  appendCborBstr(out, KS256_PROTECTED_HEADER);
  out.push(0xa2);
  out.push(...CBOR_KEY_FORESTRIE_GRANT_V0);
  appendCborBstr(out, grantPayloadBytes);
  out.push(...CBOR_KEY_IDTIMESTAMP);
  appendCborBstr(out, new Uint8Array(IDTIMESTAMP_BYTES));
  appendCborBstr(out, payloadDigest);
  appendCborBstr(out, signature);
  return new Uint8Array(out);
}

/** Verify KS256 grant COSE Sign1 recovers the expected bootstrap address. */
export function verifyKs256GrantStatement(
  sign1Bytes: Uint8Array,
  expectedAddress20: Uint8Array,
): boolean {
  if (expectedAddress20.length !== 20) {
    throw new Error("KS256 bootstrap address must be 20 bytes");
  }
  const sign1 = decode(sign1Bytes) as unknown[];
  if (!Array.isArray(sign1) || sign1.length !== 4) return false;
  const protectedBytes =
    sign1[0] instanceof Uint8Array ? sign1[0] : new Uint8Array(0);
  const payloadBytes =
    sign1[2] instanceof Uint8Array ? sign1[2] : new Uint8Array(0);
  const signature =
    sign1[3] instanceof Uint8Array ? sign1[3] : new Uint8Array(0);
  if (signature.length !== KS256_EOA_SIG_BYTES) return false;

  const sigStructure = encodeSigStructure(
    protectedBytes,
    new Uint8Array(0),
    payloadBytes,
  );
  const hash = keccak_256(sigStructure);
  const r = signature.slice(0, 32);
  const s = signature.slice(32, 64);
  let v = signature[64]!;
  if (v >= 27) v -= 27;
  const recovery = v;
  if (recovery > 3) return false;
  try {
    const sig = secp256k1.Signature.fromCompact(
      new Uint8Array([...r, ...s]),
    ).addRecoveryBit(recovery);
    const pub = sig.recoverPublicKey(hash);
    const recovered = addressFromUncompressedPubkey(pub.toRawBytes(false));
    return bytesEqual(recovered, expectedAddress20);
  } catch {
    return false;
  }
}

/** Build + sign KS256 root creation grant for `rootLogId`. */
export function mintKs256RootGrantWithWalletKey(opts: {
  rootLogId: string;
  bootstrapAddress20: Uint8Array;
  ks256PrivateKeyHex: string;
}): { grantBase64: string; grantData: Uint8Array } {
  if (opts.bootstrapAddress20.length !== 20) {
    throw new Error("KS256 bootstrap address must be 20 bytes");
  }
  const derived = ks256AddressFromPrivateKeyHex(opts.ks256PrivateKeyHex);
  if (!bytesEqual(derived, opts.bootstrapAddress20)) {
    throw new Error(
      "KS256 bootstrap private key does not match on-chain bootstrapConfig() address",
    );
  }

  const id16 = uuidToBytes(opts.rootLogId);
  const grant: Grant = {
    logId: id16,
    ownerLogId: id16,
    grant: authLogBootstrapShapedFlags(),
    maxHeight: 0,
    minGrowth: 0,
    grantData: opts.bootstrapAddress20,
  };

  const payloadBytes = encodeGrantPayloadV0Canonical(grant);
  const sign1 = signGrantPayloadWithKs256Wallet(
    payloadBytes,
    opts.ks256PrivateKeyHex,
  );
  if (!verifyKs256GrantStatement(sign1, opts.bootstrapAddress20)) {
    throw new Error(
      "KS256 root grant COSE Sign1 failed local ecrecover verification",
    );
  }
  return {
    grantBase64: bytesToForestrieGrantBase64(sign1),
    grantData: opts.bootstrapAddress20,
  };
}

/** Sign an arbitrary grant with the KS256 contract bootstrap wallet. */
export function signGrantWithKs256WalletKey(
  grant: Grant,
  ks256PrivateKeyHex: string,
): string {
  const payloadBytes = encodeGrantPayloadV0Canonical(grant);
  const sign1 = signGrantPayloadWithKs256Wallet(
    payloadBytes,
    ks256PrivateKeyHex,
  );
  const addr = ks256AddressFromPrivateKeyHex(ks256PrivateKeyHex);
  if (!verifyKs256GrantStatement(sign1, addr)) {
    throw new Error(
      "KS256 grant COSE Sign1 failed local ecrecover verification",
    );
  }
  return bytesToForestrieGrantBase64(sign1);
}
