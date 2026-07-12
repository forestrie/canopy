import {
  encodeCborDeterministic,
  encodeSigStructure,
} from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
import {
  ByokMaterialValidationError,
  validateByokDelegationMaterial,
} from "../../src/validate-byok-material.js";
import {
  buildTestByokMaterial,
  generateTestRootKeyPair,
  testDelegatedCoseKey,
} from "./byok-material-fixture.js";

function cborBytes(value: unknown): Uint8Array {
  return encodeCborDeterministic(value);
}

describe("validateByokDelegationMaterial", () => {
  it("rejects certificate with string-key delegated map in payload", async () => {
    const logHex32 = "0123456789abcdef0123456789abcdef";
    const rootKeyPair = await generateTestRootKeyPair();
    const delegatedPublicKey = testDelegatedCoseKey(42);
    const raw = new Uint8Array(
      (await crypto.subtle.exportKey(
        "raw",
        rootKeyPair.publicKey,
      )) as ArrayBuffer,
    );
    const x = raw.slice(1, 33);
    const y = raw.slice(33, 65);
    const kid = new Uint8Array(
      await crypto.subtle.digest("SHA-256", raw),
    ).slice(0, 16);
    const protectedBytes = cborBytes(
      new Map<number, unknown>([
        [1, -7],
        [3, "application/forestrie.delegation+cbor"],
        [4, kid],
      ]),
    );
    const payloadBytes = encodeCborDeterministic({
      1: logHex32,
      3: 0,
      4: 7,
      5: {
        "1": 2,
        "-1": 1,
        "-2": new Uint8Array(32).fill(1),
        "-3": new Uint8Array(32).fill(2),
      },
      6: {},
      7: 1,
      8: 1_700_000_000,
      9: 1_700_003_600,
      10: new Uint8Array(16),
    });
    const payloadBuf =
      payloadBytes instanceof Uint8Array
        ? payloadBytes
        : new Uint8Array(payloadBytes as ArrayLike<number>);
    const sigStructure = encodeSigStructure(
      protectedBytes,
      new Uint8Array(),
      payloadBuf,
    );
    const sigBuf = sigStructure.buffer.slice(
      sigStructure.byteOffset,
      sigStructure.byteOffset + sigStructure.byteLength,
    ) as ArrayBuffer;
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        rootKeyPair.privateKey,
        sigBuf,
      ),
    );
    const certificate = cborBytes([
      protectedBytes,
      new Map<number, unknown>(),
      payloadBuf,
      signature,
    ]);

    await expect(
      validateByokDelegationMaterial({
        logIdHex32: logHex32,
        mmrStart: 0,
        mmrEnd: 7,
        delegatedPublicKey,
        certificate,
        publicRoot: { alg: "ES256", x, y },
      }),
    ).rejects.toBeInstanceOf(ByokMaterialValidationError);
  });

  it("rejects certificate with bstr delegated key at payload field 5", async () => {
    const logHex32 = "0123456789abcdef0123456789abcdef";
    const rootKeyPair = await generateTestRootKeyPair();
    const delegatedPublicKey = testDelegatedCoseKey(42);
    const raw = new Uint8Array(
      (await crypto.subtle.exportKey(
        "raw",
        rootKeyPair.publicKey,
      )) as ArrayBuffer,
    );
    const x = raw.slice(1, 33);
    const y = raw.slice(33, 65);
    const kid = new Uint8Array(
      await crypto.subtle.digest("SHA-256", raw),
    ).slice(0, 16);
    const protectedBytes = cborBytes(
      new Map<number, unknown>([
        [1, -7],
        [3, "application/forestrie.delegation+cbor"],
        [4, kid],
      ]),
    );
    const delegatedKeyBytes = encodeCborDeterministic(
      new Map<number, unknown>([
        [1, 2],
        [-1, 1],
        [-2, new Uint8Array(32).fill(1)],
        [-3, new Uint8Array(32).fill(2)],
      ]),
    );
    const delegatedBstr =
      delegatedKeyBytes instanceof Uint8Array
        ? delegatedKeyBytes
        : new Uint8Array(delegatedKeyBytes as ArrayLike<number>);
    const payloadBytes = encodeCborDeterministic(
      new Map<number, unknown>([
        [1, logHex32],
        [3, 0],
        [4, 7],
        [5, delegatedBstr],
        [6, new Map()],
        [7, 1],
        [8, 1_700_000_000],
        [9, 1_700_003_600],
        [10, new Uint8Array(16)],
      ]),
    );
    const payloadBuf =
      payloadBytes instanceof Uint8Array
        ? payloadBytes
        : new Uint8Array(payloadBytes as ArrayLike<number>);
    const sigStructure = encodeSigStructure(
      protectedBytes,
      new Uint8Array(),
      payloadBuf,
    );
    const sigBuf = sigStructure.buffer.slice(
      sigStructure.byteOffset,
      sigStructure.byteOffset + sigStructure.byteLength,
    ) as ArrayBuffer;
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        rootKeyPair.privateKey,
        sigBuf,
      ),
    );
    const certificate = cborBytes([
      protectedBytes,
      new Map<number, unknown>(),
      payloadBuf,
      signature,
    ]);

    await expect(
      validateByokDelegationMaterial({
        logIdHex32: logHex32,
        mmrStart: 0,
        mmrEnd: 7,
        delegatedPublicKey,
        certificate,
        publicRoot: { alg: "ES256", x, y },
      }),
    ).rejects.toMatchObject({
      name: "ByokMaterialValidationError",
      message: expect.stringContaining("not bstr"),
    });
  });

  it("accepts valid runner-shaped material", async () => {
    const logHex32 = "1123456789abcdef0123456789abcdef";
    const rootKeyPair = await generateTestRootKeyPair();
    const delegatedPublicKey = encodeCborDeterministic(
      new Map<number, unknown>([
        [1, 2],
        [-1, 1],
        [-2, new Uint8Array(32).fill(3)],
        [-3, new Uint8Array(32).fill(4)],
      ]),
    );
    const delegatedBytes =
      delegatedPublicKey instanceof Uint8Array
        ? delegatedPublicKey
        : new Uint8Array(delegatedPublicKey as ArrayLike<number>);

    const { certificate, x, y, issuedAt, expiresAt } =
      await buildTestByokMaterial({
        rootKeyPair,
        logIdHex32: logHex32,
        mmrStart: 1,
        mmrEnd: 8,
        delegatedPublicKey: delegatedBytes,
      });

    await expect(
      validateByokDelegationMaterial({
        logIdHex32: logHex32,
        mmrStart: 1,
        mmrEnd: 8,
        delegatedPublicKey: delegatedBytes,
        certificate,
        publicRoot: { alg: "ES256", x, y },
      }),
    ).resolves.toBeUndefined();

    expect(issuedAt).toBeGreaterThan(0);
    expect(expiresAt).toBeGreaterThan(issuedAt);
  });
});
