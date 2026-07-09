/**
 * On-chain delegation proof construction for KS256 forest roots. The univocity
 * contract (`delegationVerifier.verifyDelegationProofKS256`) requires the root
 * to sign a COSE Sig_structure over a packed payload
 * `domain ‖ logId32 ‖ mmrStart ‖ mmrEnd ‖ delegatedX ‖ delegatedY` with a
 * KS256-only protected header `{1: -65799}`. Byte-identical to arbor
 * `delegationcert.BuildOnchainDelegationToBeSigned` (KS256 variant) — the
 * proof travels coordinator → custodian → sealer → publisher → contract.
 *
 * The contract requires an on-chain proof whenever a delegated key signs the
 * checkpoint receipt, regardless of root algorithm. This module covers the
 * BYOK KS256 wallet leg only: ES256 roots can either sign receipts directly
 * or (custodial path) have the custodian KMS sign the ES256-header proof in
 * arbor; a BYOK ES256 wallet leg does not exist yet.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesEqual } from "./bytes-utils.js";
import { encodeIntKeyCbor } from "./encode-int-map.js";
import { encodeSigStructure } from "./encode-sig-structure.js";
import type { Ks256VerifyHooks } from "./ks256-verify-hooks.js";
import {
  COSE_ALG_KS256,
  COSE_HEADER_ALG,
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

/** To-be-signed material for a KS256 on-chain delegation proof. */
export interface OnchainDelegationToBeSigned {
  /** KS256 protected header bytes `{1: -65799}`. */
  protectedHeader: Uint8Array;
  /** Delegated key `x ‖ y` (64 bytes) as the contract expects. */
  delegationKey: Uint8Array;
  /** Sig_structure bytes; root signs keccak256 of these. */
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

/**
 * Build the KS256 on-chain delegation TBS: protected header, packed
 * delegation key, and the Sig_structure bytes the root wallet must sign
 * (keccak256 digest, secp256k1, 65-byte `r‖s‖v`).
 *
 * @param input - Delegation scope and delegated P-256 key coordinates.
 */
export function buildOnchainDelegationToBeSigned(
  input: OnchainDelegationInput,
): OnchainDelegationToBeSigned {
  if (input.delegatedKeyX.length !== 32 || input.delegatedKeyY.length !== 32) {
    throw new Error("delegated key coordinates must be 32 bytes each");
  }
  const protectedHeader = encodeIntKeyCbor(
    new Map<number, unknown>([[COSE_HEADER_ALG, COSE_ALG_KS256]]),
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
  const tbs = buildOnchainDelegationToBeSigned(input);
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
  const tbs = buildOnchainDelegationToBeSigned(input);
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
