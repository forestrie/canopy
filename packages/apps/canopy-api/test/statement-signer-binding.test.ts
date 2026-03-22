/**
 * Statement signer binding: data-log grant flags + grantData only (ARC-0001 §6).
 */

import { describe, expect, it } from "vitest";
import {
  isStatementRegistrationGrant,
  statementSignerBindingBytes,
} from "../src/grant/statement-signer-binding.js";
import type { Grant } from "../src/grant/types.js";

function assembly(overrides: Partial<Grant> = {}): Grant {
  const grant = new Uint8Array(8);
  grant[4] = 0x03; // GF_CREATE | GF_EXTEND
  grant[7] = 0x02; // GF_DATA_LOG
  return {
    logId: new Uint8Array(32),
    ownerLogId: new Uint8Array(32),
    grant,
    maxHeight: 0,
    minGrowth: 0,
    grantData: new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

describe("isStatementRegistrationGrant", () => {
  it("is true for data-log grant with extend", () => {
    expect(isStatementRegistrationGrant(assembly())).toBe(true);
  });

  it("is true for bootstrap-shaped auth grant (GF_AUTH_LOG + GF_CREATE|GF_EXTEND)", () => {
    const g = new Uint8Array(8);
    g[4] = 0x03;
    g[7] = 0x01;
    expect(isStatementRegistrationGrant(assembly({ grant: g }))).toBe(true);
  });

  it("is false for GF_AUTH_LOG without GF_CREATE|GF_EXTEND", () => {
    const g = new Uint8Array(8);
    g[4] = 0x02;
    g[7] = 0x01;
    expect(isStatementRegistrationGrant(assembly({ grant: g }))).toBe(false);
  });

  it("is false without extend capability for data-log class", () => {
    const g = new Uint8Array(8);
    g[7] = 0x02;
    expect(isStatementRegistrationGrant(assembly({ grant: g }))).toBe(false);
  });
});

describe("statementSignerBindingBytes", () => {
  it("uses first 32 bytes when grantData is 64-byte x||y", () => {
    const gd = new Uint8Array(64);
    for (let i = 0; i < 64; i++) gd[i] = i;
    const a = assembly({ grantData: gd });
    expect([...statementSignerBindingBytes(a)]).toEqual([
      ...gd.subarray(0, 32),
    ]);
  });

  it("uses full grantData when shorter than 64", () => {
    const a = assembly({ grantData: new Uint8Array([0xaa, 0xbb]) });
    expect([...statementSignerBindingBytes(a)]).toEqual([0xaa, 0xbb]);
  });

  it("matches 32-byte kid material", () => {
    const kid = new Uint8Array(32);
    kid[0] = 0x42;
    const a = assembly({ grantData: kid });
    expect(statementSignerBindingBytes(a)).toEqual(kid);
  });
});
