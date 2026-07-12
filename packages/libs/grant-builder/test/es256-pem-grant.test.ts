import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  assertRootGrantTransparentStatement,
  base64ToBytes,
  bytesToForestrieGrantBase64,
  encodeGrantPayloadV0Canonical,
  es256GrantData64FromPrivateKeyPem,
  mintEs256RootGrantWithBootstrapPem,
  signGrantPayloadWithEs256Pem,
  uuidToBytes,
  authLogBootstrapShapedFlags,
  type Grant,
} from "../src/index.js";

const ROOT_LOG_ID = "0198c1a2-3b4c-7d5e-8f60-718293a4b5c6";

function newEs256Pem(): string {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  return privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

describe("ES256 PEM grant assembly", () => {
  it("mints a root grant that passes the transparent statement assertion", () => {
    const pem = newEs256Pem();
    const key64 = es256GrantData64FromPrivateKeyPem(pem);
    expect(key64.length).toBe(64);

    const { grantBase64, grantData } = mintEs256RootGrantWithBootstrapPem({
      rootLogId: ROOT_LOG_ID,
      bootstrapKey64: key64,
      es256PrivateKeyPem: pem,
    });
    expect(grantData).toEqual(key64);
    expect(() =>
      assertRootGrantTransparentStatement(grantBase64),
    ).not.toThrow();
  });

  it("rejects a PEM whose public key differs from the on-chain bootstrap key", () => {
    const pem = newEs256Pem();
    const otherKey64 = es256GrantData64FromPrivateKeyPem(newEs256Pem());
    expect(() =>
      mintEs256RootGrantWithBootstrapPem({
        rootLogId: ROOT_LOG_ID,
        bootstrapKey64: otherKey64,
        es256PrivateKeyPem: pem,
      }),
    ).toThrow(/does not match the on-chain bootstrapConfig/);
  });

  it("signGrantPayloadWithEs256Pem emits the Custodian profile shape", () => {
    const pem = newEs256Pem();
    const id16 = uuidToBytes(ROOT_LOG_ID);
    const grant: Grant = {
      logId: id16,
      ownerLogId: id16,
      grant: authLogBootstrapShapedFlags(),
      maxHeight: 0,
      minGrowth: 0,
      grantData: es256GrantData64FromPrivateKeyPem(pem),
    };
    const sign1 = signGrantPayloadWithEs256Pem(
      encodeGrantPayloadV0Canonical(grant),
      pem,
    );
    const b64 = bytesToForestrieGrantBase64(sign1);
    expect(base64ToBytes(b64)).toEqual(sign1);
    expect(() => assertRootGrantTransparentStatement(b64)).not.toThrow();
  });
});
