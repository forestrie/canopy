import { encodeSigStructure } from "@forestrie/encoding";
import { calculateRoot, type Proof } from "@forestrie/merklelog";
import { encode as encodeCbor } from "cbor-x";
import type { Grant } from "@forestrie/encoding";
import { grantCommitmentHashFromGrant } from "../../src/grant-commitment.js";
import { COSE_ALG_ES256 } from "../../src/cose-key.js";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_SCHEMA_V2,
} from "../../src/forest-genesis-labels.js";
import { univocityLeafHash } from "../../src/leaf-commitment.js";
import { fromPaddedWire32, toPaddedWire32 } from "../../src/uuid-bytes.js";
import { SubtleHasher } from "../../src/subtle-hasher.js";
import { inclusionProofForIndex } from "./mmr-inclusion-proof.js";

const VDS_COSE_RECEIPT_PROOFS_TAG = 396;

function cborBytes(value: unknown): Uint8Array {
  const encoded = encodeCbor(value);
  return encoded instanceof Uint8Array
    ? encoded
    : new Uint8Array(encoded as ArrayLike<number>);
}

export async function generateP256KeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function grantWithData(logId: string, grantData: Uint8Array): Grant {
  const owner = uuidToBytes(logId);
  const g = new Uint8Array(8);
  g[3] = 0x03;
  g[7] = 0x01;
  return {
    logId: owner,
    ownerLogId: owner,
    grant: g,
    maxHeight: 0,
    minGrowth: 0,
    grantData,
  };
}

export async function peakForLeafProof(
  leafHash: Uint8Array,
  proof: Proof,
): Promise<Uint8Array> {
  const hasher = new SubtleHasher();
  const leafIdx =
    proof.leafIndex !== undefined ? proof.leafIndex : proof.mmrIndex!;
  return calculateRoot(hasher, leafHash, proof, leafIdx);
}

async function buildDetachedPeakReceipt(opts: {
  signer: CryptoKeyPair;
  peak: Uint8Array;
  proof: Proof;
}): Promise<Uint8Array> {
  const protectedInner = cborBytes(new Map<number, unknown>([[1, -7]]));
  const sigStructure = encodeSigStructure(
    protectedInner,
    new Uint8Array(0),
    opts.peak,
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      opts.signer.privateKey,
      sigStructure.buffer.slice(
        sigStructure.byteOffset,
        sigStructure.byteOffset + sigStructure.byteLength,
      ) as ArrayBuffer,
    ),
  );
  const mmrIndex = opts.proof.mmrIndex ?? opts.proof.leafIndex ?? 0n;
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
  return cborBytes([protectedInner, unprot, null, sig]);
}

export async function buildGrantReceiptFixture(): Promise<{
  genesisCbor: Uint8Array;
  receiptCbor: Uint8Array;
  grant: Grant;
  idtimestampBe8: Uint8Array;
  rootKeyPair: CryptoKeyPair;
}> {
  const rootKeyPair = await generateP256KeyPair();
  const rootRaw = new Uint8Array(
    (await crypto.subtle.exportKey(
      "raw",
      rootKeyPair.publicKey,
    )) as ArrayBuffer,
  );
  const bootstrapKey = rootRaw.slice(1);

  const logId = "660e8400-e29b-41d4-a716-446655440001";
  const grant = grantWithData(logId, bootstrapKey);
  const idtimestampBe8 = new Uint8Array(8).fill(0x02);

  const inner0 = await grantCommitmentHashFromGrant(
    grantWithData(logId, new Uint8Array(64).fill(0xaa)),
  );
  const inner1 = await grantCommitmentHashFromGrant(grant);
  const id0 = new Uint8Array(8).fill(0x01);
  const leaf0Hash = await univocityLeafHash(id0, inner0);
  const leaf1Hash = await univocityLeafHash(idtimestampBe8, inner1);

  const getHash = (i: bigint) => (i === 0n ? leaf0Hash : leaf1Hash);
  const proofPath = inclusionProofForIndex(getHash, 1n, 1n);
  const proof: Proof = { path: proofPath, mmrIndex: 1n };
  const peak = await peakForLeafProof(leaf1Hash, proof);
  const receiptCbor = await buildDetachedPeakReceipt({
    signer: rootKeyPair,
    peak,
    proof,
  });

  const genesisCbor = cborBytes(
    new Map<number, unknown>([
      [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
      [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_ES256],
      [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, bootstrapKey],
      [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, new Uint8Array(20).fill(0xab)],
      [FOREST_GENESIS_LABEL_CHAIN_ID, "84532"],
      [-68010, toPaddedWire32(uuidToBytes(logId))],
    ]),
  );

  return {
    genesisCbor,
    receiptCbor,
    grant,
    idtimestampBe8,
    rootKeyPair,
  };
}
