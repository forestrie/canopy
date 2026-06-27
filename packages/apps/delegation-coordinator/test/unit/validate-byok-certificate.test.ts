import { describe, expect, it } from "vitest";
import {
  ByokCertificateValidationError,
  validateByokDelegationCertificate,
} from "../../src/validate-byok-certificate.js";
import {
  buildTestByokMaterial,
  generateTestRootKeyPair,
  testDelegatedCoseKey,
} from "./byok-material-fixture.js";

describe("validateByokDelegationCertificate submit timestamps", () => {
  const logHex32 = "0123456789abcdef0123456789abcdef";
  const delegatedPublicKey = testDelegatedCoseKey(7);

  it("rejects when submit expiresAt does not match certificate payload", async () => {
    const rootKeyPair = await generateTestRootKeyPair();
    const { certificate, issuedAt, expiresAt, x, y } =
      await buildTestByokMaterial({
        rootKeyPair,
        logIdHex32: logHex32,
        mmrStart: 1,
        mmrEnd: 8,
        delegatedPublicKey,
      });

    await expect(
      validateByokDelegationCertificate({
        logIdHex32: logHex32,
        mmrStart: 1,
        mmrEnd: 8,
        delegatedPublicKey,
        certificate,
        issuedAt,
        expiresAt: expiresAt + 86_400,
        publicRoot: { alg: "ES256", x, y },
      }),
    ).rejects.toMatchObject({
      name: "ByokCertificateValidationError",
      message: expect.stringContaining("expiresAt"),
    });
  });

  it("accepts when submit timestamps match certificate payload", async () => {
    const rootKeyPair = await generateTestRootKeyPair();
    const { certificate, issuedAt, expiresAt, x, y } =
      await buildTestByokMaterial({
        rootKeyPair,
        logIdHex32: logHex32,
        mmrStart: 1,
        mmrEnd: 8,
        delegatedPublicKey,
      });

    await expect(
      validateByokDelegationCertificate({
        logIdHex32: logHex32,
        mmrStart: 1,
        mmrEnd: 8,
        delegatedPublicKey,
        certificate,
        issuedAt,
        expiresAt,
        publicRoot: { alg: "ES256", x, y },
      }),
    ).resolves.toBeUndefined();
  });
});
