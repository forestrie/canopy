/**
 * KS256 register-statement: kid binding + verifyKs256CoseSign1 dispatch.
 */

import { describe, expect, it } from "vitest";
import { grantDataToBytes } from "../src/grant/grant-data.js";
import { authLogBootstrapShapedFlags } from "../src/grant/grant-flags.js";
import type { Grant } from "../src/grant/types.js";
import { statementSignerBindingBytes } from "../src/grant/statement-signer-binding.js";
import {
  verifyKs256CoseSign1,
  COSE_ALG_KS256,
} from "../src/grant/ks256-verify.js";
import {
  getSignerFromCoseSign1,
  signerMatchesGrant,
  signerMatchesStatementRegistrationGrant,
} from "../src/scrapi/grant-auth.js";
import {
  ks256StatementTestAddress,
  randomKs256PrivateKeyHex,
  signKs256StatementForTest,
} from "./ks256-statement-sign.js";

const LOG_ID_BYTES = new Uint8Array(16);
LOG_ID_BYTES.set([
  0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66, 0x55,
  0x44, 0x00, 0x00,
]);

function ks256BootstrapGrant(address: Uint8Array): Grant {
  return {
    logId: LOG_ID_BYTES,
    ownerLogId: LOG_ID_BYTES,
    grant: authLogBootstrapShapedFlags(),
    maxHeight: 0,
    minGrowth: 0,
    grantData: address,
  };
}

describe("register-statement KS256", () => {
  const statementPayload = new Uint8Array([
    0xa1, 0x64, 0x6b, 0x69, 0x6e, 0x64, 0x65,
  ]);
  const grantAddress = ks256StatementTestAddress();
  const grant = ks256BootstrapGrant(grantAddress);

  it("statementSignerBindingBytes returns full 20-byte address", () => {
    expect(statementSignerBindingBytes(grant)).toEqual(grantAddress);
    expect(grantDataToBytes(grant.grantData).length).toBe(20);
  });

  it("valid KS256 statement: kid matches grantData and verify succeeds", async () => {
    const sign1 = signKs256StatementForTest(statementPayload);
    const kid = getSignerFromCoseSign1(sign1);
    expect(kid).not.toBeNull();
    expect(signerMatchesGrant(kid, grantAddress)).toBe(true);
    expect(signerMatchesStatementRegistrationGrant(kid, grant)).toBe(true);

    const ok = await verifyKs256CoseSign1(sign1, {
      kind: "KS256",
      alg: COSE_ALG_KS256,
      address: grantAddress,
    });
    expect(ok).toBe(true);
  });

  it("wrong address kid fails signerMatchesStatementRegistrationGrant", () => {
    const foreignKey = randomKs256PrivateKeyHex();
    const sign1 = signKs256StatementForTest(statementPayload, foreignKey);
    const kid = getSignerFromCoseSign1(sign1);
    expect(kid).not.toBeNull();
    expect(signerMatchesStatementRegistrationGrant(kid, grant)).toBe(false);
  });

  it("tampered signature fails verifyKs256CoseSign1", async () => {
    const sign1 = signKs256StatementForTest(statementPayload);
    sign1[sign1.length - 1] ^= 0xff;
    const ok = await verifyKs256CoseSign1(sign1, {
      kind: "KS256",
      alg: COSE_ALG_KS256,
      address: grantAddress,
    });
    expect(ok).toBe(false);
  });

  it("golden: fixed payload produces stable sign1 and verifies", async () => {
    const goldenPayload = new Uint8Array([
      0xa2, 0x64, 0x6b, 0x69, 0x6e, 0x64, 0x61, 0x76, 0x01,
    ]);
    const sign1 = signKs256StatementForTest(goldenPayload);
    expect(sign1[0]).toBe(0x84);
    expect(sign1.length).toBeGreaterThan(100);

    const ok = await verifyKs256CoseSign1(sign1, {
      kind: "KS256",
      alg: COSE_ALG_KS256,
      address: grantAddress,
    });
    expect(ok).toBe(true);
  });
});
