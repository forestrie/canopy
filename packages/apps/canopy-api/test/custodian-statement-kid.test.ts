/**
 * Custodian 16-byte COSE kid vs 64-byte x||y grantData; register-statement matcher.
 */

import { sha256 } from "@noble/hashes/sha256";
import { describe, expect, it } from "vitest";
import { custodianStatementKidFromXyGrantData } from "../src/grant/custodian-statement-kid.js";
import type { Grant } from "../src/grant/types.js";
import { signerMatchesStatementRegistrationGrant } from "../src/scrapi/grant-auth.js";

/** NIST P-256 base point G as x||y (32 + 32 bytes), big-endian. */
const SECP256R1_G_XY = (() => {
  const hx = "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296";
  const hy = "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";
  const out = new Uint8Array(64);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hx.slice(i * 2, i * 2 + 2), 16);
    out[i + 32] = parseInt(hy.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
})();

/**
 * Golden: SHA256(0x04||x||y)[:16] for secp256r1 G — must match arbor custodian KidFromECDSAPublicKey.
 */
const EXPECTED_G_KID_PREFIX = (() => {
  const u = new Uint8Array(65);
  u[0] = 0x04;
  u.set(SECP256R1_G_XY.subarray(0, 32), 1);
  u.set(SECP256R1_G_XY.subarray(32, 64), 33);
  return sha256(u).subarray(0, 16);
})();

function authBootstrapGrant(grantData: Uint8Array): Grant {
  const g = new Uint8Array(8);
  g[4] = 0x03;
  g[7] = 0x01;
  return {
    logId: new Uint8Array(32),
    ownerLogId: new Uint8Array(32),
    grant: g,
    maxHeight: 0,
    minGrowth: 0,
    grantData,
  };
}

describe("custodianStatementKidFromXyGrantData", () => {
  it("matches golden for standard base point G", () => {
    const kid = custodianStatementKidFromXyGrantData(SECP256R1_G_XY);
    expect([...kid]).toEqual([...EXPECTED_G_KID_PREFIX]);
  });

  it("is deterministic", () => {
    const a = custodianStatementKidFromXyGrantData(SECP256R1_G_XY);
    const b = custodianStatementKidFromXyGrantData(SECP256R1_G_XY);
    expect([...a]).toEqual([...b]);
  });

  it("throws when grantData is not 64 bytes", () => {
    expect(() =>
      custodianStatementKidFromXyGrantData(new Uint8Array(63)),
    ).toThrow(/64-byte/);
  });
});

describe("signerMatchesStatementRegistrationGrant", () => {
  it("accepts 32-byte kid equal to x when grantData is x||y", () => {
    const gd = new Uint8Array(64);
    gd.set(SECP256R1_G_XY.subarray(0, 32), 0);
    gd.set(SECP256R1_G_XY.subarray(32, 64), 32);
    const grant = authBootstrapGrant(gd);
    const kid32 = gd.subarray(0, 32);
    expect(signerMatchesStatementRegistrationGrant(kid32, grant)).toBe(true);
  });

  it("accepts 16-byte Custodian kid when grantData is x||y", () => {
    const grant = authBootstrapGrant(SECP256R1_G_XY);
    const kid16 = custodianStatementKidFromXyGrantData(SECP256R1_G_XY);
    expect(kid16.length).toBe(16);
    expect(signerMatchesStatementRegistrationGrant(kid16, grant)).toBe(true);
  });

  it("rejects wrong 16-byte kid", () => {
    const grant = authBootstrapGrant(SECP256R1_G_XY);
    const wrong = new Uint8Array(16).fill(0xab);
    expect(signerMatchesStatementRegistrationGrant(wrong, grant)).toBe(false);
  });

  it("rejects null kid", () => {
    const grant = authBootstrapGrant(SECP256R1_G_XY);
    expect(signerMatchesStatementRegistrationGrant(null, grant)).toBe(false);
  });
});
