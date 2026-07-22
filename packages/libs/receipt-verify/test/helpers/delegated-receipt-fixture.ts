/**
 * Delegated-receipt fixture (FOR-297): a checkpoint/receipt signed by a
 * DELEGATED key, carrying the root-signed delegation certificate at
 * unprotected label 1000 — the shape offline verify must chain through.
 */

import {
  encodeCborDeterministic,
  encodeSigStructure,
} from "@forestrie/encoding";
import { calculateRoot, type Proof } from "@forestrie/merklelog";
import type { Grant } from "@forestrie/encoding";
import { grantCommitmentHashFromGrant } from "../../src/grant-commitment.js";
import { univocityLeafHash } from "../../src/leaf-commitment.js";
import { SubtleHasher } from "../../src/subtle-hasher.js";
import { inclusionProofForIndex } from "./mmr-inclusion-proof.js";
import {
  buildGenesisCbor,
  generateP256KeyPair,
  grantWithData,
} from "./grant-receipt-fixture.js";

const VDS_COSE_RECEIPT_PROOFS_TAG = 396;
const DELEGATION_CERT_LABEL = 1000;

function cborBytes(value: unknown): Uint8Array {
  return encodeCborDeterministic(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function coseKeyMapFor(pub: CryptoKey): Promise<Map<number, unknown>> {
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pub)) as ArrayBuffer,
  );
  return new Map<number, unknown>([
    [1, 2], // kty = EC2
    [-1, 1], // crv = P-256
    [-2, raw.slice(1, 33)], // x
    [-3, raw.slice(33, 65)], // y
  ]);
}

async function es256Sign(
  privateKey: CryptoKey,
  protectedBytes: Uint8Array,
  payload: Uint8Array,
): Promise<Uint8Array> {
  const sigStructure = encodeSigStructure(
    protectedBytes,
    new Uint8Array(0),
    payload,
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      toArrayBuffer(sigStructure),
    ),
  );
}

/** Root-signed delegation certificate (COSE_Sign1) binding `delegatedPub`. */
async function buildDelegationCert(opts: {
  root: CryptoKeyPair;
  delegatedPub: CryptoKey;
  mmrStart: number;
  mmrEnd: number;
  issuedAt: number;
  expiresAt: number;
}): Promise<Uint8Array> {
  const protectedBytes = cborBytes(new Map<number, unknown>([[1, -7]]));
  const payload = cborBytes(
    new Map<number, unknown>([
      [3, opts.mmrStart],
      [4, opts.mmrEnd],
      [5, await coseKeyMapFor(opts.delegatedPub)],
      [8, opts.issuedAt],
      [9, opts.expiresAt],
      [10, new Uint8Array(16)],
    ]),
  );
  const sig = await es256Sign(opts.root.privateKey, protectedBytes, payload);
  return cborBytes([protectedBytes, new Map<number, unknown>(), payload, sig]);
}

/**
 * Independent snowflake idtimestamp → Unix seconds (mirrors the arbor
 * `snowflakeid` scheme the SUT ports; kept separate so tests do not derive the
 * expected value from the implementation under test).
 */
function idtimestampBe8ToUnixSeconds(be8: Uint8Array): number {
  const view = new DataView(be8.buffer, be8.byteOffset, 8);
  const id = view.getBigUint64(0, false);
  const ms = 1n * ((1n << 40n) - 1n) + (id >> 24n);
  return Number(ms / 1000n);
}

/** Detached-peak receipt signed by `signer`, with delegation cert at label 1000. */
async function buildDelegatedPeakReceipt(opts: {
  signer: CryptoKeyPair;
  peak: Uint8Array;
  proof: Proof;
  delegationCert: Uint8Array | null;
}): Promise<Uint8Array> {
  const protectedInner = cborBytes(new Map<number, unknown>([[1, -7]]));
  const sig = await es256Sign(
    opts.signer.privateKey,
    protectedInner,
    opts.peak,
  );
  const mmrIndex = opts.proof.mmrIndex ?? opts.proof.leafIndex ?? 0n;
  const inclusionProofEntry = new Map<number, unknown>([
    [1, mmrIndex],
    [2, opts.proof.path],
  ]);
  const unprot = new Map<number, unknown>([
    [
      VDS_COSE_RECEIPT_PROOFS_TAG,
      new Map<number, unknown>([[-1, [inclusionProofEntry]]]),
    ],
  ]);
  if (opts.delegationCert) {
    unprot.set(DELEGATION_CERT_LABEL, opts.delegationCert);
  }
  return cborBytes([protectedInner, unprot, null, sig]);
}

export async function buildDelegatedGrantReceiptFixture(opts?: {
  /** Sign the cert with a DIFFERENT root than genesis (chain break). */
  wrongRoot?: boolean;
  /** Embed no delegation cert while still signing with the delegated key. */
  omitCert?: boolean;
  /** Cert coverage range excludes the verified leaf's mmrIndex (FOR-420). */
  nonCovering?: boolean;
  /** Cert expiresAt precedes the leaf's issuance time (FOR-420). */
  expiredAtIssuance?: boolean;
  /** Cert issuedAt follows the leaf's issuance time — valid (FOR-420). */
  leafBeforeIssued?: boolean;
}): Promise<{
  genesisCbor: Uint8Array;
  receiptCbor: Uint8Array;
  grant: Grant;
  idtimestampBe8: Uint8Array;
  /** The log owner (cert issuer) public key, raw 64-byte x||y — the value a
   * caller would supply as a known log key (FOR-297 WithKeys entry). */
  ownerPublicKeyXy: Uint8Array;
}> {
  const rootKeyPair = await generateP256KeyPair();
  const delegatedKeyPair = await generateP256KeyPair();
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
  const proof: Proof = {
    path: inclusionProofForIndex(getHash, 1n, 1n),
    mmrIndex: 1n,
  };
  const hasher = new SubtleHasher();
  const peak = await calculateRoot(hasher, leaf1Hash, proof, 1n);

  const certRoot = opts?.wrongRoot ? await generateP256KeyPair() : rootKeyPair;
  // Derive the cert's validity window from the leaf's own idtimestamp so the
  // positive case is self-consistent (expiry-at-issuance, not wall-clock).
  const leafTime = idtimestampBe8ToUnixSeconds(idtimestampBe8);
  // Leaf is at mmrIndex 1. A non-covering cert sets mmrEnd below the leaf so the
  // leaf (a lower bound on the checkpoint's treeSize-1) is beyond the authorized
  // horizon; a covering cert is wide (mmrStart=0, the lane norm).
  const mmrStart = 0;
  const mmrEnd = opts?.nonCovering ? 0 : 65535;
  const issuedAt = opts?.leafBeforeIssued ? leafTime + 10 : leafTime - 3600;
  const expiresAt = opts?.expiredAtIssuance ? leafTime - 10 : leafTime + 3600;
  const delegationCert = opts?.omitCert
    ? null
    : await buildDelegationCert({
        root: certRoot,
        delegatedPub: delegatedKeyPair.publicKey,
        mmrStart,
        mmrEnd,
        issuedAt,
        expiresAt,
      });

  const receiptCbor = await buildDelegatedPeakReceipt({
    signer: delegatedKeyPair,
    peak,
    proof,
    delegationCert,
  });

  return {
    genesisCbor: buildGenesisCbor(bootstrapKey, logId),
    receiptCbor,
    grant,
    idtimestampBe8,
    ownerPublicKeyXy: bootstrapKey,
  };
}
