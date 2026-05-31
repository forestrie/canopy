/**
 * Unit tests for receipt authority resolver factory (no Workers pool).
 */

import { encode as encodeCbor } from "cbor-x";
import { encodeSigStructure } from "@canopy/encoding";
import { describe, expect, it, vi } from "vitest";
import {
  createReceiptAuthorityResolver,
  resolveReceiptVerifyKeysFromTrustRoots,
} from "../src/env/receipt-authority-resolver.js";
import { importEs256PublicKeyFromGrantDataXy64 } from "../src/scrapi/custodian-grant.js";
import { verifyCoseSign1WithParsedKey } from "@canopy/encoding";
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
    const rootPem = await exportSpkiPem(root.publicKey);
    let coordinatorRequests = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/public-root")) {
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
      }
      if (url.includes("custodian.invalid")) {
        if (url.includes("curator/log-key")) {
          return new Response(cborBytes({ keyId: "test-key" }), {
            status: 200,
            headers: { "Content-Type": "application/cbor" },
          });
        }
        if (url.includes("/public")) {
          return new Response(
            cborBytes({
              keyId: "test-key",
              publicKey: rootPem,
              alg: "ES256",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/cbor" },
            },
          );
        }
      }
      return new Response(null, { status: 404 });
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
      expect(keys!.length).toBeGreaterThanOrEqual(2);
      expect(coordinatorRequests).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("merges custodian keys when coordinator public-root does not sign the peak", async () => {
    const coordinatorRoot = await generateP256KeyPair();
    const custodyRoot = await generateP256KeyPair();
    const coordinatorRaw = new Uint8Array(
      (await crypto.subtle.exportKey(
        "raw",
        coordinatorRoot.publicKey,
      )) as ArrayBuffer,
    );
    const custodyRaw = new Uint8Array(
      (await crypto.subtle.exportKey(
        "raw",
        custodyRoot.publicKey,
      )) as ArrayBuffer,
    );
    const peak = new Uint8Array(32).fill(0x22);
    const receipt = await buildSignedPeakReceiptNoDelegation(custodyRoot, peak);

    const coordinatorKey = await importEs256PublicKeyFromGrantDataXy64(
      coordinatorRaw.slice(1),
    );
    const custodyKey = await importEs256PublicKeyFromGrantDataXy64(
      custodyRaw.slice(1),
    );

    const keys = await resolveReceiptVerifyKeysFromTrustRoots(
      "0123456789abcdef0123456789abcdef",
      receipt,
      [
        { logSigningKey: async () => coordinatorKey },
        { logSigningKey: async () => custodyKey },
      ],
    );
    expect(keys).not.toBeNull();
    const sigWithCoordinatorOnly = await verifyCoseSign1WithParsedKey(
      receipt,
      coordinatorKey,
      { detachedPayload: peak },
    );
    const sigWithMerged = await verifyCoseSign1WithParsedKey(
      receipt,
      keys![0]!,
      { detachedPayload: peak },
    );
    let sigOk = sigWithMerged;
    if (!sigOk) {
      for (const k of keys!) {
        sigOk = await verifyCoseSign1WithParsedKey(receipt, k, {
          detachedPayload: peak,
        });
        if (sigOk) break;
      }
    }
    expect(sigWithCoordinatorOnly).toBe(false);
    expect(sigOk).toBe(true);
  });
});

async function buildSignedPeakReceiptNoDelegation(
  signer: CryptoKeyPair,
  peak: Uint8Array,
): Promise<Uint8Array> {
  const protectedInner = cborBytes(new Map<number, unknown>([[1, -7]]));
  const sigStructure = encodeSigStructure(
    protectedInner,
    new Uint8Array(0),
    peak,
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signer.privateKey,
      sigStructure.buffer.slice(
        sigStructure.byteOffset,
        sigStructure.byteOffset + sigStructure.byteLength,
      ) as ArrayBuffer,
    ),
  );
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
  const unprot = new Map<number, unknown>([[396, proofs]]);
  return cborBytes([protectedInner, unprot, peak, sig]);
}

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

async function exportSpkiPem(publicKey: CryptoKey): Promise<string> {
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", publicKey)) as ArrayBuffer,
  );
  const b64 = btoa(String.fromCharCode(...spki));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}
