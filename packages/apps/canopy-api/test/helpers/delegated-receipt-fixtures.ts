/**
 * Build delegated peak receipts for offline receipt / grantAuthorize tests.
 */

import { encodeSigStructure } from "@canopy/encoding";
import { calculateRoot, type Proof } from "@canopy/merklelog";
import { encode as encodeCbor } from "cbor-x";
import { DELEGATION_CERT_LABEL } from "../../src/grant/delegation-verify.js";
import { Sha256Hasher } from "./sha256-hasher.js";

const VDS_COSE_RECEIPT_PROOFS_TAG = 396;

function cborBytes(value: unknown): Uint8Array {
  const encoded = encodeCbor(value);
  return encoded instanceof Uint8Array
    ? encoded
    : new Uint8Array(encoded as ArrayLike<number>);
}

export async function buildDelegationCert(
  custodyRoot: CryptoKeyPair,
  delegatedRawUncompressed: Uint8Array,
  logIdHex32 = "0123456789abcdef0123456789abcdef",
): Promise<Uint8Array> {
  const kid = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new Uint8Array(
        (await crypto.subtle.exportKey("raw", custodyRoot.publicKey)) as ArrayBuffer,
      ),
    ),
  ).slice(0, 16);
  const delegatedKey = new Map<number, unknown>([
    [1, 2],
    [-1, 1],
    [-2, delegatedRawUncompressed.slice(1, 33)],
    [-3, delegatedRawUncompressed.slice(33, 65)],
  ]);
  const now = Math.floor(Date.now() / 1000);
  const protectedBytes = cborBytes(
    new Map<number, unknown>([
      [1, -7],
      [3, "application/forestrie.delegation+cbor"],
      [4, kid],
    ]),
  );
  const payloadBytes = cborBytes(
    new Map<number, unknown>([
      [1, logIdHex32],
      [3, 0],
      [4, 1024],
      [5, delegatedKey],
      [6, new Map<string, unknown>()],
      [7, 1],
      [8, now],
      [9, now + 3600],
      [10, new Uint8Array(16)],
    ]),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      custodyRoot.privateKey,
      encodeSigStructure(protectedBytes, new Uint8Array(), payloadBytes),
    ),
  );
  return cborBytes([
    protectedBytes,
    new Map<string, unknown>(),
    payloadBytes,
    signature,
  ]);
}

/** Peak hash for leaf + proof (same hasher as receipt-verify). */
export async function peakForLeafProof(
  leafHash: Uint8Array,
  proof: Proof,
): Promise<Uint8Array> {
  const hasher = new Sha256Hasher();
  const leafIdx =
    proof.leafIndex !== undefined ? proof.leafIndex : proof.mmrIndex!;
  return calculateRoot(hasher, leafHash, proof, leafIdx);
}

/**
 * Detached peak receipt (nil payload) signed by delegated key, with optional
 * delegation cert and header 396 proof — mirrors sealer + buildReceiptForEntry.
 */
export async function buildDelegatedDetachedPeakReceipt(opts: {
  delegated: CryptoKeyPair;
  custodyRoot: CryptoKeyPair;
  peak: Uint8Array;
  proof: Proof;
  includeDelegationCert: boolean;
}): Promise<Uint8Array> {
  const delegatedRaw = new Uint8Array(
    (await crypto.subtle.exportKey(
      "raw",
      opts.delegated.publicKey,
    )) as ArrayBuffer,
  );
  const protectedInner = cborBytes(new Map<number, unknown>([[1, -7]]));
  const sigStructure = encodeSigStructure(
    protectedInner,
    new Uint8Array(0),
    opts.peak,
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      opts.delegated.privateKey,
      sigStructure.buffer.slice(
        sigStructure.byteOffset,
        sigStructure.byteOffset + sigStructure.byteLength,
      ) as ArrayBuffer,
    ),
  );

  const mmrIndex =
    opts.proof.mmrIndex ?? opts.proof.leafIndex ?? 0n;
  const inclusionProofEntry = new Map<number, unknown>([
    [1, mmrIndex],
    [2, opts.proof.path],
  ]);
  const verifiableProofs = new Map<number, unknown>([
    [-1, [inclusionProofEntry]],
  ]);
  const unprot = new Map<number, unknown>([
    [VDS_COSE_RECEIPT_PROOFS_TAG, verifiableProofs],
  ]);
  if (opts.includeDelegationCert) {
    unprot.set(
      DELEGATION_CERT_LABEL,
      await buildDelegationCert(opts.custodyRoot, delegatedRaw),
    );
  }

  return cborBytes([protectedInner, unprot, null, sig]);
}

export async function generateP256KeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}
