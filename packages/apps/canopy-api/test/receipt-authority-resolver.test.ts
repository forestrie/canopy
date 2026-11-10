/**
 * Unit tests for receipt authority resolver factory (no Workers pool).
 */

import { encodeCborDeterministic } from "@forestrie/encoding";
import { encodeSigStructure } from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
import { readerAnswering } from "./helpers/log-authority-stub.js";
import {
  createReceiptAuthorityResolver,
  isTrustRootUnresolved,
  resolveReceiptVerifyKeysFromTrustRoots,
} from "../src/env/receipt-authority-resolver.js";
import { TrustRootNotFoundError } from "../src/env/trust-root-client.js";
import { importEs256PublicKeyFromGrantDataXy64 } from "../src/scrapi/custodian-grant.js";
import { DELEGATION_CERT_LABEL } from "../src/grant/delegation-verify.js";

describe("createReceiptAuthorityResolver", () => {
  it("returns an async resolver in pool test mode when test xy hex is configured", () => {
    const resolve = createReceiptAuthorityResolver({
      nodeEnv: "test",
      testReceiptVerifyEs256XyHex: "11".repeat(64),
    });
    expect(typeof resolve).toBe("function");
  });

  it("resolves delegated receipt keys from injected test root material", async () => {
    const { rootXy, receipt } = await delegatedReceipt();
    const resolve = createReceiptAuthorityResolver({
      nodeEnv: "test",
      testReceiptVerifyEs256XyHex: bytesToHex(rootXy),
    });

    const keys = await resolve("0123456789abcdef0123456789abcdef", receipt);
    expect(keys).not.toBeNull();
    expect(keys).toHaveLength(2);
  });

  it("takes the root key only from univocity's anchored answer", async () => {
    const { rootXy, receipt } = await delegatedReceipt();
    const { reader, asked } = readerAnswering({
      kind: "anchored",
      final: true,
      alg: -7,
      key: rootXy,
    });
    const resolve = createReceiptAuthorityResolver({
      nodeEnv: "dev",
      logAuthority: reader,
    });

    const keys = await resolve("0123456789abcdef0123456789abcdef", receipt);
    expect(keys).not.toBeNull();
    expect(keys!.length).toBeGreaterThanOrEqual(2);
    expect(asked).toEqual(["0123456789abcdef0123456789abcdef"]);
  });

  it("has no trust root for a pending log: retryable, never a verdict", async () => {
    const { receipt } = await delegatedReceipt();
    const resolve = createReceiptAuthorityResolver({
      nodeEnv: "dev",
      logAuthority: readerAnswering({ kind: "pending", state: "sequenced" })
        .reader,
    });

    const err = await resolve(
      "0123456789abcdef0123456789abcdef",
      receipt,
    ).catch((e: unknown) => e);
    expect(isTrustRootUnresolved(err)).toBe(true);
  });

  it("verifies nothing under a conflicted log", async () => {
    const { receipt } = await delegatedReceipt();
    const resolve = createReceiptAuthorityResolver({
      nodeEnv: "dev",
      logAuthority: readerAnswering({ kind: "conflicted" }).reader,
    });

    expect(
      await resolve("0123456789abcdef0123456789abcdef", receipt),
    ).toBeNull();
  });

  it("has no trust root at all without univocity", async () => {
    const { receipt } = await delegatedReceipt();
    const resolve = createReceiptAuthorityResolver({ nodeEnv: "dev" });

    const err = await resolve(
      "0123456789abcdef0123456789abcdef",
      receipt,
    ).catch((e: unknown) => e);
    expect(isTrustRootUnresolved(err)).toBe(true);
  });
});

/** A receipt sealed by a delegate of a fresh root, with the root's x||y. */
async function delegatedReceipt(): Promise<{
  rootXy: Uint8Array;
  receipt: Uint8Array;
}> {
  const root = await generateP256KeyPair();
  const delegated = await generateP256KeyPair();
  const rootRaw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", root.publicKey)) as ArrayBuffer,
  );
  const delegatedRaw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", delegated.publicKey)) as ArrayBuffer,
  );
  const delegationCert = await buildDelegationCert(root, delegatedRaw);
  return {
    rootXy: rootRaw.slice(1),
    receipt: buildReceiptWithDelegation(delegationCert),
  };
}

describe("resolveReceiptVerifyKeysFromTrustRoots tri-state (FOR-302)", () => {
  const OWNER = "0123456789abcdef0123456789abcdef";

  it("throws TrustRootUnresolvedError when NO client resolves a trust root", async () => {
    // Every client reports the log's root as not-found — the transient case a
    // just-registered BYOK root hits before it propagates. Not a statement that
    // the receipt is invalid, so it must be distinguishable from a plain null.
    const notFound = {
      logSigningKey: async () => {
        throw new TrustRootNotFoundError("no root");
      },
    };
    let thrown: unknown;
    try {
      await resolveReceiptVerifyKeysFromTrustRoots(OWNER, new Uint8Array(0), [
        notFound,
        notFound,
      ]);
    } catch (e) {
      thrown = e;
    }
    expect(isTrustRootUnresolved(thrown)).toBe(true);
  });

  it("returns null (not a throw) when a trust root IS found but the receipt does not verify", async () => {
    // A delegation cert signed by rootA, checked against an unrelated custody
    // key: the root exists, the chain just does not validate. Terminal, so a
    // plain null — the verify-failed case, never retryable.
    const rootA = await generateP256KeyPair();
    const unrelated = await generateP256KeyPair();
    const delegated = await generateP256KeyPair();
    const delegatedRaw = new Uint8Array(
      (await crypto.subtle.exportKey(
        "raw",
        delegated.publicKey,
      )) as ArrayBuffer,
    );
    const unrelatedRaw = new Uint8Array(
      (await crypto.subtle.exportKey(
        "raw",
        unrelated.publicKey,
      )) as ArrayBuffer,
    );
    const cert = await buildDelegationCert(rootA, delegatedRaw);
    const receipt = buildReceiptWithDelegation(cert);
    const unrelatedKey = await importEs256PublicKeyFromGrantDataXy64(
      unrelatedRaw.slice(1),
    );

    const result = await resolveReceiptVerifyKeysFromTrustRoots(
      OWNER,
      receipt,
      [{ logSigningKey: async () => unrelatedKey }],
    );
    expect(result).toBeNull();
  });

  it("a client error that is NOT not-found still propagates (transport failures are not masked)", async () => {
    const boom = new Error("connection reset");
    let thrown: unknown;
    try {
      await resolveReceiptVerifyKeysFromTrustRoots(OWNER, new Uint8Array(0), [
        {
          logSigningKey: async () => {
            throw boom;
          },
        },
      ]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(boom);
    expect(isTrustRootUnresolved(thrown)).toBe(false);
  });
});

async function buildDelegationCert(
  root: CryptoKeyPair,
  delegatedRawUncompressed: Uint8Array,
): Promise<Uint8Array> {
  const kid = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new Uint8Array(
        (await crypto.subtle.exportKey("raw", root.publicKey)) as ArrayBuffer,
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
      [1, "0123456789abcdef0123456789abcdef"],
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
      root.privateKey,
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

function buildReceiptWithDelegation(delegationCert: Uint8Array): Uint8Array {
  return cborBytes([
    cborBytes(new Map<number, unknown>([[1, -7]])),
    new Map<number, unknown>([[DELEGATION_CERT_LABEL, delegationCert]]),
    new Uint8Array(),
    new Uint8Array(64),
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

async function generateP256KeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}
