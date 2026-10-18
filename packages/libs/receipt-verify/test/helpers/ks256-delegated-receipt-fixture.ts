/**
 * KS256-rooted delegated receipt fixture (plan-2610-03 D7): a forest whose
 * genesis bootstrap key is a 20-byte KS256 address, and a receipt signed by
 * a P-256 delegated key whose label-1000 certificate the KS256 root signed
 * (keccak256 over Sig_structure). Keys and signatures are generated per run;
 * nothing captured is committed.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  buildDelegationToBeSignedKs256,
  encodeIntKeyCbor,
} from "@forestrie/delegation-cose";
import {
  encodeCborDeterministic,
  encodeSigStructure,
} from "@forestrie/encoding";
import { calculateRoot, type Proof } from "@forestrie/merklelog";
import type { Grant } from "@forestrie/encoding";
import { COSE_ALG_ES256, COSE_ALG_KS256 } from "../../src/cose-key.js";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_LOG_ID,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_SCHEMA_V2,
} from "../../src/forest-genesis-labels.js";
import { grantCommitmentHashFromGrant } from "../../src/grant-commitment.js";
import { univocityLeafHash } from "../../src/leaf-commitment.js";
import { SubtleHasher } from "../../src/subtle-hasher.js";
import { toPaddedWire32 } from "../../src/uuid-bytes.js";
import {
  buildDelegatedPeakReceipt,
  coseKeyMapFor,
  idtimestampBe8ToUnixSeconds,
} from "./delegated-receipt-fixture.js";
import {
  generateP256KeyPair,
  grantWithData,
  uuidToBytes,
} from "./grant-receipt-fixture.js";
import { inclusionProofForIndex } from "./mmr-inclusion-proof.js";

/** The chain the fixture's genesis binds (Base Sepolia). */
export const KS256_FIXTURE_CHAIN_ID = 84532n;

/** A fresh secp256k1 key and its Ethereum address. */
export function newKs256Root(): { sk: Uint8Array; address: Uint8Array } {
  const sk = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(sk, false);
  return { sk, address: keccak_256(pub.slice(1)).slice(-20) };
}

/** v2 genesis with a KS256 bootstrap address and a chain binding. */
function buildKs256GenesisCbor(
  address: Uint8Array,
  logId: string,
  omitChainId: boolean,
): Uint8Array {
  const genesis = new Map<number, unknown>([
    [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
    [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_KS256],
    [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, address],
    [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, new Uint8Array(20).fill(0xab)],
    [FOREST_GENESIS_LABEL_CHAIN_ID, KS256_FIXTURE_CHAIN_ID.toString()],
    [FOREST_GENESIS_LABEL_LOG_ID, toPaddedWire32(uuidToBytes(logId))],
  ]);
  if (omitChainId) genesis.delete(FOREST_GENESIS_LABEL_CHAIN_ID);
  return encodeCborDeterministic(genesis);
}

/** `r‖s‖v` secp256k1 signature over keccak256(bytes). */
function ks256Sign(sk: Uint8Array, bytes: Uint8Array): Uint8Array {
  const sig = secp256k1.sign(keccak_256(bytes), sk, { lowS: true });
  const out = new Uint8Array(65);
  out.set(sig.toCompactRawBytes(), 0);
  out[64] = sig.recovery ?? 0;
  return out;
}

export async function buildKs256DelegatedReceiptFixture(opts?: {
  /**
   * The root is a contract (no key): the certificate carries a signature
   * ecrecover can't match, as a Safe's would.
   */
  contractRoot?: boolean;
  /** Sign the certificate with a key other than the root's. */
  wrongSigner?: boolean;
  /**
   * Protected `alg` says ES256 while the root signs KS256-style: alg
   * confusion, which must be refused although ecrecover would match.
   */
  algConfusion?: boolean;
  /** Certificate expiresAt precedes the leaf's issuance time (FOR-420). */
  expiredAtIssuance?: boolean;
  /** Genesis carries no chain id, so an attestation can't be bound. */
  omitGenesisChainId?: boolean;
}): Promise<{
  genesisCbor: Uint8Array;
  receiptCbor: Uint8Array;
  grant: Grant;
  idtimestampBe8: Uint8Array;
  rootAddress: Uint8Array;
  /** keccak256(Sig_structure) of the certificate. */
  certDigest: Uint8Array;
}> {
  const root = newKs256Root();
  const rootAddress = opts?.contractRoot
    ? crypto.getRandomValues(new Uint8Array(20))
    : root.address;
  const delegatedKeyPair = await generateP256KeyPair();

  const logId = "770e8400-e29b-41d4-a716-446655440002";
  const grant = grantWithData(logId, rootAddress);
  const idtimestampBe8 = new Uint8Array(8).fill(0x02);

  const inner0 = await grantCommitmentHashFromGrant(
    grantWithData(logId, new Uint8Array(20).fill(0xaa)),
  );
  const inner1 = await grantCommitmentHashFromGrant(grant);
  const leaf0Hash = await univocityLeafHash(new Uint8Array(8).fill(1), inner0);
  const leaf1Hash = await univocityLeafHash(idtimestampBe8, inner1);
  const proof: Proof = {
    path: inclusionProofForIndex(
      (i) => (i === 0n ? leaf0Hash : leaf1Hash),
      1n,
      1n,
    ),
    mmrIndex: 1n,
  };
  const peak = await calculateRoot(new SubtleHasher(), leaf1Hash, proof, 1n);

  const leafTime = idtimestampBe8ToUnixSeconds(idtimestampBe8);
  const delegatedPublicKeyCbor = encodeCborDeterministic(
    await coseKeyMapFor(delegatedKeyPair.publicKey),
  );
  const tbs = buildDelegationToBeSignedKs256(
    {
      logIdHex32: "770e8400e29b41d4a716446655440002",
      mmrStart: 0,
      mmrEnd: 65535,
      delegatedPublicKeyCbor,
      issuedAt: leafTime - 3600,
      expiresAt: opts?.expiredAtIssuance ? leafTime - 10 : leafTime + 3600,
      delegationId: new Uint8Array(16),
    },
    rootAddress,
  );
  const protectedBytes = opts?.algConfusion
    ? encodeIntKeyCbor(
        new Map<number, unknown>([
          [1, COSE_ALG_ES256],
          [4, rootAddress],
        ]),
      )
    : tbs.protectedBytes;
  const sigStructure = encodeSigStructure(
    protectedBytes,
    new Uint8Array(0),
    tbs.payloadBytes,
  );
  const signer =
    opts?.wrongSigner || opts?.contractRoot ? newKs256Root() : root;
  const delegationCert = encodeIntKeyCbor([
    protectedBytes,
    new Map<number, unknown>(),
    tbs.payloadBytes,
    ks256Sign(signer.sk, sigStructure),
  ]);

  const receiptCbor = await buildDelegatedPeakReceipt({
    signer: delegatedKeyPair,
    peak,
    proof,
    delegationCert,
  });

  return {
    genesisCbor: buildKs256GenesisCbor(
      rootAddress,
      logId,
      opts?.omitGenesisChainId ?? false,
    ),
    receiptCbor,
    grant,
    idtimestampBe8,
    rootAddress,
    certDigest: keccak_256(sigStructure),
  };
}
