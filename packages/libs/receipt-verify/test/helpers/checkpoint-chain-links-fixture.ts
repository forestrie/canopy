/**
 * Retained-checkpoint chains with delegation certificates, generated at run
 * time (no committed evidence). Ported from mcp-verify 0.6.1
 * `test/core/chain-links.ts` + `test/core/ks256-fixture.ts`, generalised so
 * each link carries its own sealer and certificate (a KS256 contract root
 * rotating its delegate signs one certificate per delegate).
 *
 * The chain is over a two-leaf MMR (size 3): node 0 is the sibling `0x42…`
 * in the receipt's inclusion path, node 1 is the receipt's leaf (mmrIndex
 * 1), node 2 is the peak. A chain is one link (0 -> 3, covers the leaf) or
 * two (0 -> 1, then 1 -> 3), where the first link's signed size 1 does NOT
 * cover the leaf at index 1.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  assembleDelegationCertificate,
  buildDelegationToBeSignedKs256,
  normalizeEs256SignatureLowS,
} from "@forestrie/delegation-cose";
import {
  COSE_LABEL_TREE_SIZE_2,
  COSE_LABEL_VDP,
  COSE_LABEL_VDS,
  VDP_CONSISTENCY_PROOF_KEY,
  VDS_MMR_CONSISTENCY,
  encodeCborDeterministic,
  encodeSigStructure,
} from "@forestrie/encoding";
import { calculateRoot } from "@forestrie/merklelog";
import {
  ERC1271_MAGIC_VALUE,
  accumulatorPayload,
  univocityLeafHash,
  type Ks256Attestation,
} from "../../src/index.js";
import { SubtleHasher } from "../../src/subtle-hasher.js";
import { toPaddedWire32 } from "../../src/uuid-bytes.js";
import { uuidToBytes } from "./grant-receipt-fixture.js";

/** The chain the KS256 genesis binds (Base Sepolia). */
export const CHAIN_FIXTURE_CHAIN_ID = 84532n;

const LOG_ID = "770e8400-e29b-41d4-a716-446655440002";
const LOG_ID_HEX32 = "770e8400e29b41d4a716446655440002";

export type ChainFixture = {
  /** The leaf's receipt (detached peak, signed by `sealer`). */
  receipt: Uint8Array;
  idtimestampBe8: Uint8Array;
  inner: Uint8Array;
  peak: Uint8Array;
  leafHash: Uint8Array;
  node0: Uint8Array;
};

export type Es256Root = { pair: CryptoKeyPair; keyXy: Uint8Array };
export type Ks256Signer = { sk: Uint8Array; address: Uint8Array };

export type CertLimits = {
  mmrStart?: bigint;
  mmrEnd?: bigint;
  issuedAt?: number;
  expiresAt?: number;
};

/** A KS256 certificate with the digest pair an attestation binds. */
export type Ks256Cert = {
  cert: Uint8Array;
  digest: Uint8Array;
  signatureHash: Uint8Array;
};

/** The two-leaf MMR and a receipt for leaf 1 signed by `sealer`. */
export async function buildChainFixture(
  inner: Uint8Array,
  sealer: CryptoKeyPair,
): Promise<ChainFixture> {
  const idtimestampBe8 = new Uint8Array(8).fill(0x02);
  const node0 = new Uint8Array(32).fill(0x42);
  const leafHash = await univocityLeafHash(idtimestampBe8, inner);
  const proof = { path: [node0], mmrIndex: 1n };
  const peak = await calculateRoot(new SubtleHasher(), leafHash, proof, 1n);
  const protectedBytes = encodeCborDeterministic(
    new Map<number, unknown>([[1, -7]]),
  );
  const sig = await es256Sign(
    sealer.privateKey,
    encodeSigStructure(protectedBytes, new Uint8Array(0), peak),
  );
  const receipt = encodeCborDeterministic([
    protectedBytes,
    new Map<number, unknown>([
      [
        COSE_LABEL_VDP,
        new Map<number, unknown>([
          [
            -1,
            [
              new Map<number, unknown>([
                [1, 1n],
                [2, [node0]],
              ]),
            ],
          ],
        ]),
      ],
    ]),
    null,
    sig,
  ]);
  return { receipt, idtimestampBe8, inner, peak, leafHash, node0 };
}

export async function newSealer(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

export async function newEs256Root(): Promise<Es256Root> {
  const pair = await newSealer();
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  return { pair, keyXy: raw.slice(1) };
}

export function newKs256Signer(): Ks256Signer {
  const sk = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(sk, false);
  return { sk, address: keccak_256(pub.slice(1)).slice(-20) };
}

/** Unix seconds of the fixture leaf's snowflake idtimestamp. */
export function leafUnixSeconds(fx: ChainFixture): number {
  const id = new DataView(
    fx.idtimestampBe8.buffer,
    fx.idtimestampBe8.byteOffset,
    8,
  ).getBigUint64(0, false);
  return Number(((1n << 40n) - 1n + (id >> 24n)) / 1000n);
}

/** Limits that comfortably contain the leaf and the size-3 link. */
export function wideLimits(fx: ChainFixture): Required<CertLimits> {
  const t = leafUnixSeconds(fx);
  return {
    mmrStart: 0n,
    mmrEnd: 65535n,
    issuedAt: t - 60,
    expiresAt: t + 3600,
  };
}

/** A root-signed ES256 delegation certificate for `sealer`. */
export async function buildEs256Cert(
  root: Es256Root,
  sealer: CryptoKeyPair,
  limits: CertLimits,
): Promise<Uint8Array> {
  const payload = new Map<number, unknown>([
    [5, await coseKeyMap(sealer.publicKey)],
  ]);
  if (limits.mmrStart !== undefined) payload.set(3, limits.mmrStart);
  if (limits.mmrEnd !== undefined) payload.set(4, limits.mmrEnd);
  if (limits.issuedAt !== undefined) payload.set(8, limits.issuedAt);
  if (limits.expiresAt !== undefined) payload.set(9, limits.expiresAt);
  const protectedBytes = encodeCborDeterministic(
    new Map<number, unknown>([[1, -7]]),
  );
  const payloadBytes = encodeCborDeterministic(payload);
  const sig = await es256Sign(
    root.pair.privateKey,
    encodeSigStructure(protectedBytes, new Uint8Array(0), payloadBytes),
  );
  return encodeCborDeterministic([
    protectedBytes,
    new Map<number, unknown>(),
    payloadBytes,
    sig,
  ]);
}

/**
 * A KS256 certificate for `sealer` under `rootAddress`, signed by `signer`.
 * A contract root (a Safe) is `signer` whose address is not `rootAddress`:
 * ecrecover can't match, only an attestation can carry it.
 */
export async function buildKs256Cert(opts: {
  rootAddress: Uint8Array;
  signer: Ks256Signer;
  sealer: CryptoKeyPair;
  limits: Required<CertLimits>;
}): Promise<Ks256Cert> {
  const tbs = buildDelegationToBeSignedKs256(
    {
      logIdHex32: LOG_ID_HEX32,
      mmrStart: Number(opts.limits.mmrStart),
      mmrEnd: Number(opts.limits.mmrEnd),
      delegatedPublicKeyCbor: encodeCborDeterministic(
        await coseKeyMap(opts.sealer.publicKey),
      ),
      issuedAt: opts.limits.issuedAt,
      expiresAt: opts.limits.expiresAt,
      delegationId: crypto.getRandomValues(new Uint8Array(16)),
    },
    opts.rootAddress,
  );
  const sig = secp256k1.sign(
    keccak_256(tbs.sigStructureBytes),
    opts.signer.sk,
    {
      lowS: true,
    },
  );
  const signature = new Uint8Array(65);
  signature.set(sig.toCompactRawBytes(), 0);
  signature[64] = sig.recovery ?? 0;
  return {
    cert: assembleDelegationCertificate(tbs, signature),
    digest: keccak_256(tbs.sigStructureBytes),
    signatureHash: keccak_256(signature),
  };
}

/** A v2 forest genesis with a KS256 bootstrap address and a chain id. */
export function ks256Genesis(rootAddress: Uint8Array): Uint8Array {
  return encodeCborDeterministic(
    new Map<number, unknown>([
      [-68009, 2],
      [-68010, toPaddedWire32(uuidToBytes(LOG_ID))],
      [-68011, new Uint8Array(20).fill(0xab)],
      [-68013, CHAIN_FIXTURE_CHAIN_ID.toString()],
      [-68014, -65799],
      [-68015, rootAddress],
    ]),
  );
}

/** A well-formed attestation for one KS256 certificate. */
export function attestationFor(
  rootAddress: Uint8Array,
  cert: Ks256Cert,
  overrides: Partial<Ks256Attestation> = {},
): Ks256Attestation {
  return {
    version: 1,
    chainId: CHAIN_FIXTURE_CHAIN_ID,
    address: rootAddress,
    digest: cert.digest,
    signatureHash: cert.signatureHash,
    blockNumber: 1234n,
    blockHash: new Uint8Array(32).fill(0x0b),
    magic: ERC1271_MAGIC_VALUE,
    ...overrides,
  };
}

/** One link signing size 3 (covers the leaf), sealed by `sealer`. */
export function coveringLink(
  fx: ChainFixture,
  sealer: CryptoKeyPair,
  cert: Uint8Array | null,
): Promise<Uint8Array> {
  return buildLink(sealer, cert, 3n, [0n, 3n, [], [fx.peak]], [fx.peak]);
}

/**
 * Two links, 0 -> 1 then 1 -> 3. Link 0's signed size 1 does not cover the
 * leaf at index 1; link 1's size 3 does.
 */
export async function twoLinks(
  fx: ChainFixture,
  first: { sealer: CryptoKeyPair; cert: Uint8Array | null },
  second: { sealer: CryptoKeyPair; cert: Uint8Array | null },
): Promise<Uint8Array[]> {
  return [
    await buildLink(
      first.sealer,
      first.cert,
      1n,
      [0n, 1n, [], [fx.node0]],
      [fx.node0],
    ),
    await buildLink(
      second.sealer,
      second.cert,
      3n,
      [1n, 3n, [[fx.leafHash]], []],
      [fx.peak],
    ),
  ];
}

/** One `.sth`: a consistency proof body, signed by `sealer`, cert at 1000. */
async function buildLink(
  sealer: CryptoKeyPair,
  cert: Uint8Array | null,
  size2: bigint,
  proofBody: unknown[],
  accumulator: Uint8Array[],
): Promise<Uint8Array> {
  const protectedBytes = encodeCborDeterministic(
    new Map<number, unknown>([
      [1, -7],
      [COSE_LABEL_VDS, VDS_MMR_CONSISTENCY],
      [COSE_LABEL_TREE_SIZE_2, size2],
    ]),
  );
  const sig = await es256Sign(
    sealer.privateKey,
    encodeSigStructure(
      protectedBytes,
      new Uint8Array(0),
      accumulatorPayload(accumulator),
    ),
  );
  const unprotected = new Map<number, unknown>([
    [
      COSE_LABEL_VDP,
      new Map<number, unknown>([
        [VDP_CONSISTENCY_PROOF_KEY, encodeCborDeterministic(proofBody)],
      ]),
    ],
  ]);
  if (cert !== null) unprotected.set(1000, cert);
  return encodeCborDeterministic([protectedBytes, unprotected, null, sig]);
}

async function coseKeyMap(pub: CryptoKey): Promise<Map<number, unknown>> {
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pub)) as ArrayBuffer,
  );
  return new Map<number, unknown>([
    [1, 2],
    [-1, 1],
    [-2, raw.slice(1, 33)],
    [-3, raw.slice(33, 65)],
  ]);
}

async function es256Sign(
  key: CryptoKey,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  return normalizeEs256SignatureLowS(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        new Uint8Array(bytes),
      ),
    ),
  );
}
