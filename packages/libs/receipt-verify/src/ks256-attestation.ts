/**
 * ERC-1271 attestation (plan-2610-03 D4, protocol ADR-0045 amendment
 * 2026-10-18): a caller-supplied record that a contract KS256 root (a Safe)
 * answered `isValidSignature(digest, signature)` with the ERC-1271 magic value
 * at a given block. It lets a contract-rooted delegation certificate verify
 * offline with the narrower guarantee "valid under the contract's signers at
 * the attested block".
 *
 * Same trust model as the known-accumulator snapshot (known-accumulator.ts):
 * the record is the fetching party's chain read, made explicit and auditable.
 * It binds `(chainId, address, digest, signature hash, block)`, so anyone with
 * RPC can re-run exactly that call at that block (the signature itself is in
 * the receipt's certificate) and confirm or disprove it. This package never makes
 * that call; forestrie-cli and mcp-resolve fetch it (slice 04).
 *
 * The verifier accepts an attestation only for the exact root address and
 * certificate digest, and only when `chainId` equals the forest's genesis
 * chain: the same Safe address on another chain can have other owners (D6).
 */

import {
  decodeCborDeterministic,
  encodeCborDeterministic,
} from "@forestrie/encoding";

/** ERC-1271 `isValidSignature` success value, `bytes4(0x1626ba7e)`. */
export const ERC1271_MAGIC_VALUE = new Uint8Array([0x16, 0x26, 0xba, 0x7e]);

/** CBOR map labels for the attestation artifact (strict RFC 8949 §4.2). */
const LABEL_VERSION = 1;
const LABEL_CHAIN_ID = 2;
const LABEL_ADDRESS = 3;
const LABEL_DIGEST = 4;
const LABEL_BLOCK_NUMBER = 5;
const LABEL_BLOCK_HASH = 6;
const LABEL_MAGIC = 7;
const LABEL_SIGNATURE_HASH = 8;

const KNOWN_LABELS = new Set<number>([
  LABEL_VERSION,
  LABEL_CHAIN_ID,
  LABEL_ADDRESS,
  LABEL_DIGEST,
  LABEL_BLOCK_NUMBER,
  LABEL_BLOCK_HASH,
  LABEL_MAGIC,
  LABEL_SIGNATURE_HASH,
]);

const ATTESTATION_VERSION = 1;

/** A block-bound ERC-1271 `isValidSignature` result for one digest. */
export type Ks256Attestation = {
  version: number;
  /** Chain the call was made on; must equal the forest's genesis chain. */
  chainId: bigint;
  /** Contract root address (20 bytes) the call was made to. */
  address: Uint8Array;
  /** keccak256(Sig_structure) of the delegation certificate (32 bytes). */
  digest: Uint8Array;
  /**
   * keccak256 of the signature bytes `isValidSignature` was called with
   * (32 bytes); must match the certificate's signature.
   */
  signatureHash: Uint8Array;
  /** Block the call was made at. */
  blockNumber: bigint;
  /** Hash of that block (32 bytes): the falsifiability handle. */
  blockHash: Uint8Array;
  /** The call's 4-byte return; only {@link ERC1271_MAGIC_VALUE} attests. */
  magic: Uint8Array;
};

/** Encode an attestation as canonical CBOR (RFC 8949 §4.2, hard policy). */
export function encodeKs256Attestation(
  attestation: Ks256Attestation,
): Uint8Array {
  return encodeCborDeterministic(
    new Map<number, unknown>([
      [LABEL_VERSION, attestation.version],
      [LABEL_CHAIN_ID, attestation.chainId],
      [LABEL_ADDRESS, attestation.address],
      [LABEL_DIGEST, attestation.digest],
      [LABEL_BLOCK_NUMBER, attestation.blockNumber],
      [LABEL_BLOCK_HASH, attestation.blockHash],
      [LABEL_MAGIC, attestation.magic],
      [LABEL_SIGNATURE_HASH, attestation.signatureHash],
    ]),
  );
}

function asBigint(v: unknown, what: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
    return BigInt(v);
  throw new Error(`ks256 attestation: ${what} must be an unsigned integer`);
}

function asBytes(v: unknown, length: number, what: string): Uint8Array {
  if (!(v instanceof Uint8Array) || v.length !== length) {
    throw new Error(`ks256 attestation: ${what} must be ${length} bytes`);
  }
  return v;
}

/**
 * Strict decode and shape validation of an attestation artifact: canonical
 * CBOR, known labels only, version 1, exact types and lengths.
 */
export function decodeKs256Attestation(bytes: Uint8Array): Ks256Attestation {
  let decoded: unknown;
  try {
    decoded = decodeCborDeterministic(bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`ks256 attestation is not canonical CBOR: ${message}`);
  }
  if (!(decoded instanceof Map)) {
    throw new Error("ks256 attestation must be a CBOR map");
  }
  for (const label of decoded.keys()) {
    if (!KNOWN_LABELS.has(label as number)) {
      throw new Error(`ks256 attestation: unknown label ${String(label)}`);
    }
  }
  const version = Number(asBigint(decoded.get(LABEL_VERSION), "version"));
  if (version !== ATTESTATION_VERSION) {
    throw new Error(`ks256 attestation version ${version} not supported`);
  }
  return {
    version,
    chainId: asBigint(decoded.get(LABEL_CHAIN_ID), "chainId"),
    address: asBytes(decoded.get(LABEL_ADDRESS), 20, "address"),
    digest: asBytes(decoded.get(LABEL_DIGEST), 32, "digest"),
    blockNumber: asBigint(decoded.get(LABEL_BLOCK_NUMBER), "blockNumber"),
    blockHash: asBytes(decoded.get(LABEL_BLOCK_HASH), 32, "blockHash"),
    magic: asBytes(decoded.get(LABEL_MAGIC), 4, "magic"),
    signatureHash: asBytes(
      decoded.get(LABEL_SIGNATURE_HASH),
      32,
      "signatureHash",
    ),
  };
}
