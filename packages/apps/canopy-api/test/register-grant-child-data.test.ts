/**
 * Child *data* first-grant authorization: queue-independent parent gate. See
 * https://github.com/forestrie/canopy/blob/main/docs/grants.md#6-register-grant-creation-paths
 * (path C) and the credential/evidence model in
 * https://github.com/forestrie/canopy/blob/main/docs/grants.md#10-authorization-and-evidence-model
 *
 *  - Parent is the root genesis log R (ownerLogId === bootstrap): readiness is
 *    isLogInitializedMmrs(R); the data grant must be signed by R's authority key
 *    (forest genesis x||y). No parent evidence needed (R is the trust anchor).
 *  - Parent is an intermediate auth log A: the caller supplies A's completed creation
 *    grant in the request body ({ parentGrant: <bytes> }, grants.md §11). We verify its
 *    receipt (grantAuthorize), confirm it created A, and require the data grant to be
 *    signed by the authority key A's creation grant established (its grantData x||y).
 *    No SequencingQueue read.
 */

import { encodeCoseSign1Raw, encodeSigStructure } from "@canopy/encoding";
import { sha256 } from "@noble/hashes/sha256";
import { encode as encodeCbor } from "cbor-x";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { encodeGrantPayload } from "../src/grant/codec.js";
import { grantCommitmentHashFromGrant } from "../src/grant/grant-commitment.js";
import { univocityLeafHash } from "../src/grant/leaf-commitment.js";
import type { Grant } from "../src/grant/types.js";
import {
  HEADER_FORESTRIE_GRANT_V0,
  HEADER_IDTIMESTAMP,
  HEADER_RECEIPT,
} from "../src/grant/transparent-statement.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";
import {
  registerGrant,
  type RegisterGrantEnv,
} from "../src/scrapi/register-grant.js";
import type { ParsedVerifyKey } from "@canopy/encoding";

const ROOT = "550e8400-e29b-41d4-a716-446655440000";

const genesisHolder = vi.hoisted(() => ({
  x: new Uint8Array(32),
  y: new Uint8Array(32),
}));

vi.mock("../src/scrapi/log-initialized-mmrs.js", () => ({
  isLogInitializedMmrs: vi.fn(async (logId: string) => logId === ROOT),
}));

vi.mock("../src/forest/genesis-cache.js", () => ({
  getParsedGenesis: vi.fn(async (segment: string) => {
    const { logIdToWireBytes } = await import("../src/grant/log-id-wire.js");
    try {
      return {
        wire: logIdToWireBytes(segment),
        x: genesisHolder.x,
        y: genesisHolder.y,
        schemaVersion: 0 as const,
        chainBinding: null,
      };
    } catch {
      return { kind: "bad_segment" as const };
    }
  }),
}));

vi.mock("../src/scrapi/grant-sequencing.js", () => ({
  enqueueGrantForSequencing: vi.fn(async () => ({
    statusUrlPath: `/logs/${ROOT}/${ROOT}/entries/abcd0000abcd0000abcd0000abcd0000abcd0000abcd0000abcd0000abcd0000`,
    innerHex:
      "abcd0000abcd0000abcd0000abcd0000abcd0000abcd0000abcd0000abcd0000",
    ownerLogIdUuid: ROOT,
    alreadySequenced: false,
  })),
}));

const KID = new Uint8Array(16).fill(0x42);
const PARENT_IDTS = new Uint8Array(8).fill(9);

function dataLogFlags(): Uint8Array {
  const g = new Uint8Array(8);
  g[4] = 0x03; // GF_CREATE | GF_EXTEND
  g[7] = 0x02; // GF_DATA_LOG
  return g;
}

function authLogFlags(): Uint8Array {
  const g = new Uint8Array(8);
  g[4] = 0x03; // GF_CREATE | GF_EXTEND
  g[7] = 0x01; // GF_AUTH_LOG
  return g;
}

async function pubKeyXy64(pub: CryptoKey): Promise<Uint8Array> {
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pub)) as ArrayBuffer,
  );
  if (raw.length === 65 && raw[0] === 0x04) return raw.slice(1, 65);
  if (raw.length === 64) return raw;
  throw new Error("unexpected public key length");
}

async function signEs256(
  priv: CryptoKey,
  sigStructure: Uint8Array,
): Promise<Uint8Array> {
  const buf = sigStructure.buffer.slice(
    sigStructure.byteOffset,
    sigStructure.byteOffset + sigStructure.byteLength,
  ) as ArrayBuffer;
  const sig = (await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    priv,
    buf,
  )) as ArrayBuffer;
  return new Uint8Array(sig);
}

/** Encode a Forestrie-Grant transparent statement (Custodian profile), optionally with a receipt. */
async function encodeGrantStatement(
  grant: Grant,
  signKey: CryptoKey,
  idts: Uint8Array,
  receiptBytes?: Uint8Array,
): Promise<Uint8Array> {
  const grantPayload = encodeGrantPayload(grant);
  const digest = sha256(grantPayload);
  const protectedInner = new Uint8Array(
    encodeCbor(
      new Map<number, unknown>([
        [1, -7],
        [3, "application/forestrie.custodian-statement+cbor"],
        [4, KID],
      ]),
    ),
  );
  const sig = await signEs256(
    signKey,
    encodeSigStructure(protectedInner, new Uint8Array(0), digest),
  );
  const unprot = new Map<number, unknown>([
    [HEADER_IDTIMESTAMP, idts],
    [HEADER_FORESTRIE_GRANT_V0, grantPayload],
  ]);
  if (receiptBytes) unprot.set(HEADER_RECEIPT, receiptBytes);
  return encodeCoseSign1Raw(protectedInner, unprot, digest, sig);
}

/** Build a single-leaf peak receipt (empty proof path) for `grant`, signed by `receiptPriv`. */
async function buildPeakReceipt(
  grant: Grant,
  idts: Uint8Array,
  receiptPriv: CryptoKey,
): Promise<Uint8Array> {
  const inner = await grantCommitmentHashFromGrant(grant);
  const peak = await univocityLeafHash(idts, inner);
  const protectedInner = new Uint8Array(encodeCbor(new Map([[1, -7]])));
  const sig = await signEs256(
    receiptPriv,
    encodeSigStructure(protectedInner, new Uint8Array(0), peak),
  );
  const proofs = new Map<number, unknown>([
    [
      -1,
      [
        new Map<number, unknown>([
          [1, 0],
          [2, []],
        ]),
      ],
    ],
  ]);
  const unprot = new Map<number, unknown>([[396, proofs]]);
  return encodeCoseSign1Raw(protectedInner, unprot, peak, sig);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function baseEnv(
  resolveReceiptAuthority?: RegisterGrantEnv["resolveReceiptAuthority"],
): RegisterGrantEnv {
  return {
    queueEnv: {
      sequencingQueue: {} as DurableObjectNamespace,
      shardCountStr: "4",
    },
    bootstrapEnv: {
      bootstrapLogId: ROOT,
      r2Grants: {} as R2Bucket,
      custodianUrl: "",
      custodianAppToken: "",
      r2Mmrs: {} as R2Bucket,
      massifHeight: 14,
    },
    resolveReceiptAuthority,
  };
}

let genesisPair: CryptoKeyPair;
let authPair: CryptoKeyPair;
let receiptPair: CryptoKeyPair;
let otherPair: CryptoKeyPair;
let delegatedXy: Uint8Array;

beforeAll(async () => {
  const gen = async () =>
    (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
  genesisPair = await gen();
  authPair = await gen();
  receiptPair = await gen();
  otherPair = await gen();
  const gx = await pubKeyXy64(genesisPair.publicKey);
  genesisHolder.x = gx.slice(0, 32);
  genesisHolder.y = gx.slice(32, 64);
  delegatedXy = new Uint8Array(64).fill(0x11);
});

describe("registerGrant child data first grant — root-owned (parent == R)", () => {
  it("303 when root initialized and data grant signed by genesis key", async () => {
    const dataLogId = "111e4567-e89b-12d3-a456-426614174001";
    const grant: Grant = {
      logId: uuidToBytes(dataLogId),
      ownerLogId: uuidToBytes(ROOT),
      grant: dataLogFlags(),
      maxHeight: 0,
      minGrowth: 0,
      grantData: delegatedXy,
    };
    const bytes = await encodeGrantStatement(
      grant,
      genesisPair.privateKey,
      new Uint8Array(8),
    );
    const req = new Request(`http://test/register/${ROOT}/grants`, {
      method: "POST",
      headers: { Authorization: `Forestrie-Grant ${toBase64(bytes)}` },
    });
    const res = await registerGrant(req, baseEnv());
    expect(res.status).toBe(303);
  });

  it("403 when data grant is not signed by the genesis key", async () => {
    const dataLogId = "111e4567-e89b-12d3-a456-426614174002";
    const grant: Grant = {
      logId: uuidToBytes(dataLogId),
      ownerLogId: uuidToBytes(ROOT),
      grant: dataLogFlags(),
      maxHeight: 0,
      minGrowth: 0,
      grantData: delegatedXy,
    };
    const bytes = await encodeGrantStatement(
      grant,
      otherPair.privateKey,
      new Uint8Array(8),
    );
    const req = new Request(`http://test/register/${ROOT}/grants`, {
      method: "POST",
      headers: { Authorization: `Forestrie-Grant ${toBase64(bytes)}` },
    });
    const res = await registerGrant(req, baseEnv());
    expect(res.status).toBe(403);
  });
});

describe("registerGrant child data first grant — intermediate auth log A (parent != R)", () => {
  const authLogId = "222e4567-e89b-12d3-a456-426614174010";
  const dataLogId = "333e4567-e89b-12d3-a456-426614174011";

  /** Build A's completed creation grant (transparent statement bytes) to send as evidence. */
  async function parentGrantBytes(
    overrides?: Partial<Grant>,
  ): Promise<Uint8Array> {
    const authXy = await pubKeyXy64(authPair.publicKey);
    const parentGrant: Grant = {
      logId: uuidToBytes(authLogId),
      ownerLogId: uuidToBytes(ROOT),
      grant: authLogFlags(),
      maxHeight: 0,
      minGrowth: 0,
      grantData: authXy,
      ...overrides,
    };
    const receipt = await buildPeakReceipt(
      parentGrant,
      PARENT_IDTS,
      receiptPair.privateKey,
    );
    return encodeGrantStatement(
      parentGrant,
      authPair.privateKey,
      PARENT_IDTS,
      receipt,
    );
  }

  /** CBOR request body carrying the parent grant evidence (grants.md §11). */
  async function parentGrantBody(
    overrides?: Partial<Grant>,
  ): Promise<Uint8Array> {
    return encodeCbor({ parentGrant: await parentGrantBytes(overrides) });
  }

  async function dataGrantHeader(signKey: CryptoKey): Promise<string> {
    const grant: Grant = {
      logId: uuidToBytes(dataLogId),
      ownerLogId: uuidToBytes(authLogId),
      grant: dataLogFlags(),
      maxHeight: 0,
      minGrowth: 0,
      grantData: delegatedXy,
    };
    const bytes = await encodeGrantStatement(grant, signKey, new Uint8Array(8));
    return `Forestrie-Grant ${toBase64(bytes)}`;
  }

  const resolveToReceiptSigner =
    (): RegisterGrantEnv["resolveReceiptAuthority"] =>
    async (): Promise<ParsedVerifyKey[]> => [receiptPair.publicKey];

  it("303 when parent creation grant receipt verifies and data grant signed by A's authority key", async () => {
    const req = new Request(`http://test/register/${ROOT}/grants`, {
      method: "POST",
      headers: {
        Authorization: await dataGrantHeader(authPair.privateKey),
        "content-type": "application/cbor",
      },
      body: await parentGrantBody(),
    });
    const res = await registerGrant(req, baseEnv(resolveToReceiptSigner()));
    expect(res.status).toBe(303);
  });

  it("403 when the parent grant body is absent", async () => {
    const req = new Request(`http://test/register/${ROOT}/grants`, {
      method: "POST",
      headers: { Authorization: await dataGrantHeader(authPair.privateKey) },
    });
    const res = await registerGrant(req, baseEnv(resolveToReceiptSigner()));
    expect(res.status).toBe(403);
  });

  it("403 when the parent grant receipt does not verify (wrong receipt authority)", async () => {
    const wrongResolver: RegisterGrantEnv["resolveReceiptAuthority"] =
      async (): Promise<ParsedVerifyKey[]> => [otherPair.publicKey];
    const req = new Request(`http://test/register/${ROOT}/grants`, {
      method: "POST",
      headers: {
        Authorization: await dataGrantHeader(authPair.privateKey),
        "content-type": "application/cbor",
      },
      body: await parentGrantBody(),
    });
    const res = await registerGrant(req, baseEnv(wrongResolver));
    expect(res.status).toBe(403);
  });

  it("403 when the parent grant creates a different log (logId mismatch)", async () => {
    const req = new Request(`http://test/register/${ROOT}/grants`, {
      method: "POST",
      headers: {
        Authorization: await dataGrantHeader(authPair.privateKey),
        "content-type": "application/cbor",
      },
      body: await parentGrantBody({
        logId: uuidToBytes("999e4567-e89b-12d3-a456-426614174099"),
      }),
    });
    const res = await registerGrant(req, baseEnv(resolveToReceiptSigner()));
    expect(res.status).toBe(403);
  });

  it("403 when data grant is not signed by A's authority key", async () => {
    const req = new Request(`http://test/register/${ROOT}/grants`, {
      method: "POST",
      headers: {
        Authorization: await dataGrantHeader(otherPair.privateKey),
        "content-type": "application/cbor",
      },
      body: await parentGrantBody(),
    });
    const res = await registerGrant(req, baseEnv(resolveToReceiptSigner()));
    expect(res.status).toBe(403);
  });
});
