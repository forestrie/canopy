/**
 * WebAuthn-enveloped delegation certificate validation (plan-2608-13 phase 2,
 * devdocs ADR-0063): the certificate self-describes via protected alg -65800;
 * dispatch is fail-closed both directions and only an ES256 (P-256 x/y) root
 * can be a passkey.
 */

import { describe, expect, it } from "vitest";
import { decodeCborDeterministic } from "@forestrie/encoding";
import { encodeIntKeyCbor } from "@forestrie/delegation-cose";
import { validateByokDelegationCertificate } from "../../src/validate-byok-certificate.js";
import {
  buildTestByokMaterial,
  buildTestByokWebauthnMaterial,
  generateTestRootKeyPair,
  testDelegatedCoseKey,
} from "./byok-material-fixture.js";

const LOG_HEX32 = "0123456789abcdef0123456789abcdef";

describe("validateByokDelegationCertificate — WebAuthn envelope (ADR-0063)", () => {
  const delegatedPublicKey = testDelegatedCoseKey(7);

  async function webauthnMaterial(rootKeyPair: CryptoKeyPair) {
    return buildTestByokWebauthnMaterial({
      rootKeyPair,
      logIdHex32: LOG_HEX32,
      mmrStart: 1,
      mmrEnd: 8,
      delegatedPublicKey,
    });
  }

  it("accepts a WebAuthn-enveloped certificate against the ES256 root", async () => {
    const rootKeyPair = await generateTestRootKeyPair();
    const m = await webauthnMaterial(rootKeyPair);
    await expect(
      validateByokDelegationCertificate({
        logIdHex32: LOG_HEX32,
        mmrStart: 1,
        mmrEnd: 8,
        delegatedPublicKey,
        certificate: m.certificate,
        issuedAt: m.issuedAt,
        expiresAt: m.expiresAt,
        publicRoot: { alg: "ES256", x: m.x, y: m.y },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a WebAuthn certificate signed by a different passkey", async () => {
    const rootKeyPair = await generateTestRootKeyPair();
    const otherKeyPair = await generateTestRootKeyPair();
    const m = await webauthnMaterial(otherKeyPair);
    const raw = new Uint8Array(
      (await crypto.subtle.exportKey(
        "raw",
        rootKeyPair.publicKey,
      )) as ArrayBuffer,
    );
    await expect(
      validateByokDelegationCertificate({
        logIdHex32: LOG_HEX32,
        mmrStart: 1,
        mmrEnd: 8,
        delegatedPublicKey,
        certificate: m.certificate,
        issuedAt: m.issuedAt,
        expiresAt: m.expiresAt,
        publicRoot: {
          alg: "ES256",
          x: raw.slice(1, 33),
          y: raw.slice(33, 65),
        },
      }),
    ).rejects.toMatchObject({
      name: "ByokCertificateValidationError",
      message: expect.stringContaining("signature invalid"),
    });
  });

  it("rejects a WebAuthn certificate under a KS256 root (fail-closed)", async () => {
    const rootKeyPair = await generateTestRootKeyPair();
    const m = await webauthnMaterial(rootKeyPair);
    await expect(
      validateByokDelegationCertificate({
        logIdHex32: LOG_HEX32,
        mmrStart: 1,
        mmrEnd: 8,
        delegatedPublicKey,
        certificate: m.certificate,
        issuedAt: m.issuedAt,
        expiresAt: m.expiresAt,
        publicRoot: { alg: "KS256", key: new Uint8Array(20).fill(0xaa) },
      }),
    ).rejects.toMatchObject({
      name: "ByokCertificateValidationError",
      message: expect.stringContaining("ES256 public root"),
    });
  });

  it("rejects an envelope smuggled under a plain ES256 alg (ADR-0063 §5)", async () => {
    const rootKeyPair = await generateTestRootKeyPair();
    const plain = await buildTestByokMaterial({
      rootKeyPair,
      logIdHex32: LOG_HEX32,
      mmrStart: 1,
      mmrEnd: 8,
      delegatedPublicKey,
    });
    // Re-assemble the valid plain certificate with a spurious envelope in the
    // unprotected header; Sig_structure (and so the signature) is unchanged.
    const arr = decodeCborDeterministic(plain.certificate) as unknown[];
    const tampered = encodeIntKeyCbor([
      arr[0],
      new Map<number, unknown>([
        [-65800, [new Uint8Array(37), new Uint8Array(8)]],
      ]),
      arr[2],
      arr[3],
    ]);
    await expect(
      validateByokDelegationCertificate({
        logIdHex32: LOG_HEX32,
        mmrStart: 1,
        mmrEnd: 8,
        delegatedPublicKey,
        certificate: tampered,
        issuedAt: plain.issuedAt,
        expiresAt: plain.expiresAt,
        publicRoot: { alg: "ES256", x: plain.x, y: plain.y },
      }),
    ).rejects.toMatchObject({
      name: "ByokCertificateValidationError",
      message: expect.stringContaining("unexpected WebAuthn envelope"),
    });
  });
});
