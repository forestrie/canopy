/**
 * Unit tests for receipt authority resolver factory (no Workers pool).
 */

import { encode as encodeCbor } from "cbor-x";
import { encodeSigStructure } from "@canopy/encoding";
import { describe, expect, it, vi } from "vitest";
import { createReceiptAuthorityResolver } from "../src/env/receipt-authority-resolver.js";
import { DELEGATION_CERT_LABEL } from "../src/grant/delegation-verify.js";

describe("createReceiptAuthorityResolver", () => {
  it("returns an async resolver in dev mode", () => {
    const resolve = createReceiptAuthorityResolver({
      trustRootUrl: "https://custodian.example/v1",
      nodeEnv: "dev",
    });
    expect(typeof resolve).toBe("function");
  });

  it("returns an async resolver in pool test mode when test xy hex is configured", () => {
    const resolve = createReceiptAuthorityResolver({
      trustRootUrl: "https://custodian.example/v1",
      nodeEnv: "test",
      testReceiptVerifyEs256XyHex: "11".repeat(64),
    });
    expect(typeof resolve).toBe("function");
  });

  it("resolves delegated receipt keys from injected non-Custodian root material", async () => {
    const root = await generateP256KeyPair();
    const delegated = await generateP256KeyPair();
    const rootRaw = new Uint8Array(
      (await crypto.subtle.exportKey("raw", root.publicKey)) as ArrayBuffer,
    );
    const delegatedRaw = new Uint8Array(
      (await crypto.subtle.exportKey(
        "raw",
        delegated.publicKey,
      )) as ArrayBuffer,
    );
    const rootXy = rootRaw.slice(1);
    const delegationCert = await buildDelegationCert(root, delegatedRaw);
    const receipt = buildReceiptWithDelegation(delegationCert);

    const resolve = createReceiptAuthorityResolver({
      trustRootUrl: "https://custodian.invalid/v1",
      nodeEnv: "test",
      testReceiptVerifyEs256XyHex: bytesToHex(rootXy),
    });

    const keys = await resolve("0123456789abcdef0123456789abcdef", receipt);
    expect(keys).not.toBeNull();
    expect(keys).toHaveLength(2);
  });

  it("resolves delegated receipt keys from coordinator public-root before Custodian fallback", async () => {
    const root = await generateP256KeyPair();
    const delegated = await generateP256KeyPair();
    const rootRaw = new Uint8Array(
      (await crypto.subtle.exportKey("raw", root.publicKey)) as ArrayBuffer,
    );
    const delegatedRaw = new Uint8Array(
      (await crypto.subtle.exportKey(
        "raw",
        delegated.publicKey,
      )) as ArrayBuffer,
    );
    const rootX = rootRaw.slice(1, 33);
    const rootY = rootRaw.slice(33, 65);
    const delegationCert = await buildDelegationCert(root, delegatedRaw);
    const receipt = buildReceiptWithDelegation(delegationCert);
    let coordinatorRequests = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.endsWith("/public-root")) {
        return new Response(null, { status: 404 });
      }
      coordinatorRequests++;
      const body = cborBytes({
        logId: new Uint8Array(16),
        alg: "ES256",
        x: rootX,
        y: rootY,
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/cbor" },
      });
    });
    try {
      const resolve = createReceiptAuthorityResolver({
        trustRootUrl: "https://custodian.invalid/v1",
        coordinatorTrustRootUrl: "https://coordinator.example",
        coordinatorToken: "coordinator-token",
        nodeEnv: "dev",
      });

      const keys = await resolve("0123456789abcdef0123456789abcdef", receipt);
      expect(keys).not.toBeNull();
      expect(keys).toHaveLength(2);
      expect(coordinatorRequests).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
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
  const encoded = encodeCbor(value);
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
