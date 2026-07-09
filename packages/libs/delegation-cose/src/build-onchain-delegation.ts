/**
 * On-chain delegation proof construction (univocity delegationVerifier). The
 * contract requires the log root to sign a COSE Sig_structure over the packed
 * payload `domain ‖ logId32 ‖ mmrStart ‖ mmrEnd ‖ delegatedX ‖ delegatedY`
 * whenever a delegated key signs the checkpoint receipt — which is always the
 * case for sealer-produced checkpoints. Byte-identical to arbor
 * `delegationcert.BuildOnchainDelegationToBeSigned`; the proof travels
 * coordinator → custodian → sealer → publisher → contract.
 *
 * Both root algorithms are supported uniformly:
 * - KS256 roots (`{1: -65799}` header) sign keccak256 of the Sig_structure
 *   with secp256k1 (65-byte `r‖s‖v`; ecrecover or ERC-1271 on-chain). The
 *   proof is unconditionally required — a secp256k1 address cannot sign an
 *   ES256 receipt itself.
 * - ES256 roots (`{1: -7}` header) sign SHA-256 of the Sig_structure with
 *   P-256 (64-byte IEEE P1363 `r‖s`, low-s normalized: the on-chain verifier
 *   rejects malleable high-s signatures).
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesEqual, toArrayBuffer } from "./bytes-utils.js";
import { encodeIntKeyCbor } from "./encode-int-map.js";
import { encodeSigStructure } from "./encode-sig-structure.js";
import type { Ks256VerifyHooks } from "./ks256-verify-hooks.js";
import {
  COSE_ALG_ES256,
  COSE_ALG_KS256,
  COSE_HEADER_ALG,
  ES256_SIG_BYTES,
  KS256_EOA_SIG_BYTES,
} from "./payload-labels.js";

/** Domain separator for the contract's delegation Sig_structure payload. */
export const ONCHAIN_DELEGATION_DOMAIN = "forestrie.univocity.delegation.v1";

/** Scope and delegated key material bound by the on-chain delegation proof. */
export interface OnchainDelegationInput {
  /** Forestrie log id as 32-char hex (16 bytes, right-aligned to 32). */
  logIdHex: string;
  /** Inclusive MMR start index of the delegation lease. */
  mmrStart: number | bigint;
  /** Exclusive MMR end index of the delegation lease. */
  mmrEnd: number | bigint;
  /** Delegated P-256 public key x coordinate (32 bytes). */
  delegatedKeyX: Uint8Array;
  /** Delegated P-256 public key y coordinate (32 bytes). */
  delegatedKeyY: Uint8Array;
}

/** To-be-signed material for an on-chain delegation proof. */
export interface OnchainDelegationToBeSigned {
  /** Protected header bytes carrying the root alg (`{1: -65799}` or `{1: -7}`). */
  protectedHeader: Uint8Array;
  /** Delegated key `x ‖ y` (64 bytes) as the contract expects. */
  delegationKey: Uint8Array;
  /** Sig_structure bytes; root signs keccak256 (KS256) or SHA-256 (ES256). */
  sigStructureBytes: Uint8Array;
}

/**
 * Wire shape of the proof returned to the sealer; field names must match
 * arbor `delegationcert.OnchainDelegationProof` CBOR tags.
 */
export interface OnchainDelegationProofParts {
  protectedHeader: Uint8Array;
  delegationKey: Uint8Array;
  mmrStart: bigint;
  mmrEnd: bigint;
  signature: Uint8Array;
}

function bigEndianUint64(value: number | bigint): Uint8Array {
  const v = BigInt(value);
  if (v < 0n || v > 0xffffffffffffffffn) {
    throw new Error("mmr index out of uint64 range");
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v);
  return out;
}

function logId32FromHex(logIdHex: string): Uint8Array {
  const hex = logIdHex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error("log id must be 32-char hex (16 bytes)");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 16; i++) {
    out[16 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function buildOnchainDelegationToBeSignedWithAlg(
  input: OnchainDelegationInput,
  alg: number,
): OnchainDelegationToBeSigned {
  if (input.delegatedKeyX.length !== 32 || input.delegatedKeyY.length !== 32) {
    throw new Error("delegated key coordinates must be 32 bytes each");
  }
  const protectedHeader = encodeIntKeyCbor(
    new Map<number, unknown>([[COSE_HEADER_ALG, alg]]),
  );
  const logId32 = logId32FromHex(input.logIdHex);
  const domain = new TextEncoder().encode(ONCHAIN_DELEGATION_DOMAIN);
  const mmrStart = bigEndianUint64(input.mmrStart);
  const mmrEnd = bigEndianUint64(input.mmrEnd);

  const payload = new Uint8Array(domain.length + 32 + 8 + 8 + 32 + 32);
  let off = 0;
  for (const part of [
    domain,
    logId32,
    mmrStart,
    mmrEnd,
    input.delegatedKeyX,
    input.delegatedKeyY,
  ]) {
    payload.set(part, off);
    off += part.length;
  }

  const delegationKey = new Uint8Array(64);
  delegationKey.set(input.delegatedKeyX, 0);
  delegationKey.set(input.delegatedKeyY, 32);

  return {
    protectedHeader,
    delegationKey,
    sigStructureBytes: encodeSigStructure(
      protectedHeader,
      new Uint8Array(),
      payload,
    ),
  };
}

/**
 * Build the KS256 on-chain delegation TBS: protected header, packed
 * delegation key, and the Sig_structure bytes the root wallet must sign
 * (keccak256 digest, secp256k1, 65-byte `r‖s‖v`).
 *
 * @param input - Delegation scope and delegated P-256 key coordinates.
 */
export function buildOnchainDelegationToBeSignedKs256(
  input: OnchainDelegationInput,
): OnchainDelegationToBeSigned {
  return buildOnchainDelegationToBeSignedWithAlg(input, COSE_ALG_KS256);
}

/**
 * Build the ES256 on-chain delegation TBS: protected header, packed
 * delegation key, and the Sig_structure bytes the root must sign (SHA-256
 * digest, P-256, 64-byte IEEE P1363 `r‖s`, low-s).
 *
 * @param input - Delegation scope and delegated P-256 key coordinates.
 */
export function buildOnchainDelegationToBeSignedEs256(
  input: OnchainDelegationInput,
): OnchainDelegationToBeSigned {
  return buildOnchainDelegationToBeSignedWithAlg(input, COSE_ALG_ES256);
}

/**
 * Sign an on-chain delegation proof with an in-process secp256k1 root key
 * (tests and local tooling; production wallets sign externally over
 * `sigStructureBytes`).
 *
 * @param input - Delegation scope and delegated P-256 key coordinates.
 * @param privateKeyHex - Root secp256k1 private key as 64-char hex.
 */
export function signOnchainDelegationKs256(
  input: OnchainDelegationInput,
  privateKeyHex: string,
): OnchainDelegationProofParts {
  const tbs = buildOnchainDelegationToBeSignedKs256(input);
  const hash = keccak_256(tbs.sigStructureBytes);
  const hex = privateKeyHex.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("KS256 private key must be 32-byte hex (64 chars)");
  }
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    sk[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const sigObj = secp256k1.sign(hash, sk, { lowS: true });
  const signature = new Uint8Array(KS256_EOA_SIG_BYTES);
  signature.set(sigObj.toCompactRawBytes(), 0);
  signature[64] = sigObj.recovery ?? 0;
  return {
    protectedHeader: tbs.protectedHeader,
    delegationKey: tbs.delegationKey,
    mmrStart: BigInt(input.mmrStart),
    mmrEnd: BigInt(input.mmrEnd),
    signature,
  };
}

/** P-256 group order (SEC 2) for low-s normalization. */
const P256_N = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);
const P256_HALF_N = P256_N >> 1n;

/**
 * Return the low-s form of a raw 64-byte P-256 signature: `(r, n-s)` verifies
 * for exactly the same digest and key. Mirrors arbor
 * `delegationcert.NormalizeES256SignatureLowS`; the on-chain P256 verifier
 * rejects malleable high-s signatures and WebCrypto/KMS make no low-s
 * guarantee. Inputs that are not 64 bytes are returned unchanged.
 *
 * @param signature - IEEE P1363 `r‖s` signature bytes.
 */
export function normalizeEs256SignatureLowS(signature: Uint8Array): Uint8Array {
  if (signature.length !== ES256_SIG_BYTES) {
    return signature;
  }
  let s = 0n;
  for (let i = 32; i < 64; i++) {
    s = (s << 8n) | BigInt(signature[i]!);
  }
  if (s <= P256_HALF_N) {
    return signature;
  }
  s = P256_N - s;
  const out = new Uint8Array(64);
  out.set(signature.slice(0, 32), 0);
  for (let i = 0; i < 32; i++) {
    out[63 - i] = Number((s >> BigInt(8 * i)) & 0xffn);
  }
  return out;
}

/**
 * Sign an on-chain delegation proof with an in-process P-256 root
 * {@link CryptoKeyPair} (tests and local tooling; production roots sign
 * externally over `sigStructureBytes`). The signature is normalized to low-s.
 *
 * @param input - Delegation scope and delegated P-256 key coordinates.
 * @param rootKeyPair - P-256 root key authorizing the delegation.
 */
export async function signOnchainDelegationEs256(
  input: OnchainDelegationInput,
  rootKeyPair: CryptoKeyPair,
): Promise<OnchainDelegationProofParts> {
  const tbs = buildOnchainDelegationToBeSignedEs256(input);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      rootKeyPair.privateKey,
      toArrayBuffer(tbs.sigStructureBytes),
    ),
  );
  if (signature.length !== ES256_SIG_BYTES) {
    throw new Error(
      `expected P-256 signature to be ${ES256_SIG_BYTES} bytes, got ${signature.length}`,
    );
  }
  return {
    protectedHeader: tbs.protectedHeader,
    delegationKey: tbs.delegationKey,
    mmrStart: BigInt(input.mmrStart),
    mmrEnd: BigInt(input.mmrEnd),
    signature: normalizeEs256SignatureLowS(signature),
  };
}

function addressFromUncompressedPubkey(uncompressed: Uint8Array): Uint8Array {
  return keccak_256(uncompressed.slice(1)).slice(-20);
}

/**
 * Verify a wallet's on-chain delegation signature against the expected KS256
 * root address (EOA recovery, or ERC-1271 via hooks for contract roots).
 * Mirrors the contract's `verifyDelegationProofKS256`.
 *
 * @param input - Delegation scope the signature must bind.
 * @param signature - 65-byte `r‖s‖v` over keccak256(Sig_structure).
 * @param rootSignerAddress - 20-byte trusted root address.
 * @param hooks - Optional ERC-1271 hooks for contract-wallet roots.
 */
export async function verifyOnchainDelegationSignatureKs256(
  input: OnchainDelegationInput,
  signature: Uint8Array,
  rootSignerAddress: Uint8Array,
  hooks?: Ks256VerifyHooks,
): Promise<boolean> {
  if (rootSignerAddress.length !== 20) {
    throw new Error("KS256 root signer address must be 20 bytes");
  }
  const tbs = buildOnchainDelegationToBeSignedKs256(input);
  const hash = keccak_256(tbs.sigStructureBytes);

  if (hooks) {
    const isContract = await hooks.hasContractCode(rootSignerAddress);
    if (isContract) {
      return hooks.isValidSignature(rootSignerAddress, hash, signature);
    }
  }

  if (signature.length !== KS256_EOA_SIG_BYTES) {
    return false;
  }
  let v = signature[64]!;
  if (v >= 27) v -= 27;
  if (v > 3) return false;
  try {
    const sig = secp256k1.Signature.fromCompact(
      signature.slice(0, 64),
    ).addRecoveryBit(v);
    const pub = sig.recoverPublicKey(hash).toRawBytes(false);
    return bytesEqual(addressFromUncompressedPubkey(pub), rootSignerAddress);
  } catch {
    return false;
  }
}

/**
 * Verify a root's on-chain delegation signature against the expected ES256
 * root public key coordinates. Mirrors the contract's
 * `verifyDelegationProofES256` (SHA-256 digest, P-256 verify).
 *
 * @param input - Delegation scope the signature must bind.
 * @param signature - 64-byte IEEE P1363 `r‖s` over the Sig_structure.
 * @param rootX - Root P-256 public key x coordinate (32 bytes).
 * @param rootY - Root P-256 public key y coordinate (32 bytes).
 */
export async function verifyOnchainDelegationSignatureEs256(
  input: OnchainDelegationInput,
  signature: Uint8Array,
  rootX: Uint8Array,
  rootY: Uint8Array,
): Promise<boolean> {
  if (rootX.length !== 32 || rootY.length !== 32) {
    throw new Error("ES256 root coordinates must be 32 bytes each");
  }
  if (signature.length !== ES256_SIG_BYTES) {
    return false;
  }
  const tbs = buildOnchainDelegationToBeSignedEs256(input);
  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  raw.set(rootX, 1);
  raw.set(rootY, 33);
  let rootKey: CryptoKey;
  try {
    rootKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(raw),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    return false;
  }
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    rootKey,
    toArrayBuffer(signature),
    toArrayBuffer(tbs.sigStructureBytes),
  );
}
