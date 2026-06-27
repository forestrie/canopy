/**
 * KS256 (secp256k1 / Ethereum-style) delegation certificate builders. Digest is
 * `keccak256(Sig_structure)`; protected header `kid` is the 20-byte root signer
 * address. Contract-wallet roots require ERC-1271 verification at verify time —
 * see {@link verifyDelegationCertificateKs256}.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { assembleDelegationCertificate } from "./assemble-certificate.js";
import { buildDelegationToBeSignedKs256 } from "./build-tbs-ks256.js";
import type { DelegationInput } from "./delegation-input.js";
import { KS256_EOA_SIG_BYTES } from "./payload-labels.js";

/**
 * Callback that signs the COSE Sig_structure bytes with a KS256 root key held
 * outside this library (mandate agent, local wallet, or RPC `eth_sign`).
 */
export type SignKs256 = (
  sigStructureBytes: Uint8Array,
) => Promise<Uint8Array> | Uint8Array;

/**
 * Parse a 32-byte secp256k1 private key from hex for local/test signing only.
 *
 * @param raw - 64-character hex (optional `0x` prefix).
 */
function parseKs256PrivateKeyHex(raw: string): Uint8Array {
  const hex = raw.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "KS256 bootstrap private key must be 32-byte hex (64 chars)",
    );
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Build a complete KS256 delegation certificate using an in-process root
 * private key (tests and local tooling).
 *
 * @param input - Delegation scope and delegated public key material.
 * @param rootSignerAddress - 20-byte Ethereum address of the signing root.
 * @param privateKeyHex - Root secp256k1 private key as hex.
 */
export async function buildDelegationCertificateKs256(
  input: DelegationInput,
  rootSignerAddress: Uint8Array,
  privateKeyHex: string,
): Promise<Uint8Array> {
  const tbs = buildDelegationToBeSignedKs256(input, rootSignerAddress);
  const hash = keccak_256(tbs.sigStructureBytes);
  const sk = parseKs256PrivateKeyHex(privateKeyHex);
  const sigObj = secp256k1.sign(hash, sk, { lowS: true });
  const compact = sigObj.toCompactRawBytes();
  const signature = new Uint8Array(KS256_EOA_SIG_BYTES);
  signature.set(compact, 0);
  signature[64] = sigObj.recovery ?? 0;
  return assembleDelegationCertificate(tbs, signature);
}

/**
 * Build a KS256 delegation certificate when the root signs externally over
 * `tbs.sigStructureBytes`.
 *
 * @param input - Delegation scope and delegated public key material.
 * @param rootSignerAddress - 20-byte address matching protected-header kid.
 * @param sign - Signs the keccak256 hash of Sig_structure; must return 65-byte
 *   `r‖s‖v`.
 */
export async function buildDelegationCertificateKs256WithSigner(
  input: DelegationInput,
  rootSignerAddress: Uint8Array,
  sign: SignKs256,
): Promise<Uint8Array> {
  const tbs = buildDelegationToBeSignedKs256(input, rootSignerAddress);
  const signature = await sign(tbs.sigStructureBytes);
  return assembleDelegationCertificate(tbs, signature);
}
