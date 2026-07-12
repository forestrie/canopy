/**
 * Receipt authority resolver must not conflate distinct receipts on the same owner log.
 * Prior cache key used only byteLength, so two receipts of equal size reused the first
 * delegation resolution (RCA: auth-data-log-chain parent grant 403).
 */

import {
  decodeCborDeterministic,
  encodeCborDeterministic,
} from "@forestrie/encoding";
import {
  encodeSigStructure,
  verifyCoseSign1WithParsedKey,
} from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
import {
  createReceiptAuthorityResolver,
  receiptResolverCacheKeySuffix,
} from "../src/env/receipt-authority-resolver.js";
import { es256ReceiptVerifyKeys } from "../src/env/decode-trust-root-cbor.js";
import { DELEGATION_CERT_LABEL } from "../src/grant/delegation-verify.js";

const OWNER_HEX = "0123456789abcdef0123456789abcdef";

describe("receipt authority resolver cache", () => {
  it("uses SHA-256 suffix so equal-length receipts do not share a cache entry", async () => {
    const a = new Uint8Array(400).fill(0xaa);
    const b = new Uint8Array(400).fill(0xbb);
    const suffixA = await receiptResolverCacheKeySuffix(a);
    const suffixB = await receiptResolverCacheKeySuffix(b);
    expect(suffixA).not.toBe(suffixB);
    const legacyLengthOnlyKey = (r: Uint8Array) =>
      `${OWNER_HEX}\0${r.byteLength}`;
    expect(legacyLengthOnlyKey(a)).toBe(legacyLengthOnlyKey(b));
  });

  it("resolves verify keys that match each receipt (equal length, different delegation)", async () => {
    const custody = await generateP256KeyPair();
    const delegateA = await generateP256KeyPair();
    const delegateB = await generateP256KeyPair();
    const custodyRaw = await exportUncompressed(custody.publicKey);
    const delegateARaw = await exportUncompressed(delegateA.publicKey);
    const delegateBRaw = await exportUncompressed(delegateB.publicKey);

    const receiptA = await buildSignedPeakReceipt(
      custody,
      delegateA,
      delegateARaw,
    );
    const receiptB = await buildSignedPeakReceipt(
      custody,
      delegateB,
      delegateBRaw,
    );
    expect(receiptA.length).toBe(receiptB.length);

    const resolve = createReceiptAuthorityResolver({
      trustRootUrl: "https://custodian.invalid/v1",
      nodeEnv: "test",
      testReceiptVerifyEs256XyHex: bytesToHex(custodyRaw.slice(1)),
    });

    const keysA = await resolve(OWNER_HEX, receiptA);
    const keysB = await resolve(OWNER_HEX, receiptB);
    expect(keysA).not.toBeNull();
    expect(keysB).not.toBeNull();

    const es256A = es256ReceiptVerifyKeys(keysA!);
    const es256B = es256ReceiptVerifyKeys(keysB!);

    const sigOkAWithA = await verifyCoseSign1WithParsedKey(
      receiptA,
      es256A[0]!,
      {
        detachedPayload: await peakFromReceipt(receiptA),
      },
    );
    const sigOkBWithBCachedWrong = await verifyCoseSign1WithParsedKey(
      receiptB,
      es256A[0]!,
      { detachedPayload: await peakFromReceipt(receiptB) },
    );
    const sigOkBWithB = await verifyCoseSign1WithParsedKey(
      receiptB,
      es256B[0]!,
      {
        detachedPayload: await peakFromReceipt(receiptB),
      },
    );

    expect(sigOkAWithA).toBe(true);
    expect(sigOkBWithB).toBe(true);
    expect(sigOkBWithBCachedWrong).toBe(false);
  });
});

async function peakFromReceipt(receiptBytes: Uint8Array): Promise<Uint8Array> {
  const arr = decodeCborDeterministic(receiptBytes) as unknown[];
  if (!Array.isArray(arr) || arr.length !== 4) {
    throw new Error("invalid receipt");
  }
  const payload = arr[2];
  if (payload instanceof Uint8Array && payload.length === 32) return payload;
  throw new Error("receipt must carry 32-byte peak payload for this test");
}

async function buildSignedPeakReceipt(
  custody: CryptoKeyPair,
  delegate: CryptoKeyPair,
  delegateRaw: Uint8Array,
): Promise<Uint8Array> {
  const peak = new Uint8Array(32).fill(0x11);
  const protectedInner = new Uint8Array(
    encodeCborDeterministic(new Map([[1, -7]])),
  );
  const sigStructure = encodeSigStructure(
    protectedInner,
    new Uint8Array(0),
    peak,
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      delegate.privateKey,
      sigStructure.buffer.slice(
        sigStructure.byteOffset,
        sigStructure.byteOffset + sigStructure.byteLength,
      ) as ArrayBuffer,
    ),
  );
  const delegationCert = await buildDelegationCert(custody, delegateRaw);
  const proofs = new Map<number, unknown>([
    [
      -1,
      [
        new Map<number, unknown>([
          [1, 0n],
          [2, []],
        ]),
      ],
    ],
  ]);
  const unprot = new Map<number, unknown>([
    [396, proofs],
    [DELEGATION_CERT_LABEL, delegationCert],
  ]);
  return encodeCborDeterministic([protectedInner, unprot, peak, sig]);
}

async function buildDelegationCert(
  root: CryptoKeyPair,
  delegatedRawUncompressed: Uint8Array,
): Promise<Uint8Array> {
  const kid = new Uint8Array(16).fill(0x42);
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
      [1, OWNER_HEX],
      [3, 0],
      [4, 1024],
      [5, delegatedKey],
      [6, new Map<number, unknown>()],
      [7, 1],
      [8, now],
      [9, now + 3600],
      [10, new Uint8Array(16)],
    ]),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      root.privateKey,
      encodeSigStructure(protectedBytes, new Uint8Array(), payloadBytes),
    ),
  );
  return cborBytes([
    protectedBytes,
    new Map<number, unknown>(),
    payloadBytes,
    signature,
  ]);
}

function cborBytes(value: unknown): Uint8Array {
  const encoded = encodeCborDeterministic(value);
  return encoded instanceof Uint8Array
    ? encoded
    : new Uint8Array(encoded as ArrayLike<number>);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function exportUncompressed(pub: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(
    (await crypto.subtle.exportKey("raw", pub)) as ArrayBuffer,
  );
}

async function generateP256KeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}
