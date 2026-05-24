/**
 * Unit tests for delegation certificate extraction (no Workers pool).
 */

import { encode } from "cbor-x";
import { describe, expect, it } from "vitest";

import {
  DELEGATION_CERT_LABEL,
  extractDelegationCertBytes,
} from "../src/grant/delegation-verify.js";

describe("extractDelegationCertBytes", () => {
  it("returns cert bytes from unprotected header label 1000", () => {
    const cert = new Uint8Array([1, 2, 3, 4]);
    const unprotected = new Map<number, unknown>([[DELEGATION_CERT_LABEL, cert]]);
    expect(extractDelegationCertBytes(unprotected)).toEqual(cert);
  });

  it("returns null when label 1000 is absent", () => {
    expect(extractDelegationCertBytes(new Map())).toBeNull();
    expect(extractDelegationCertBytes(undefined)).toBeNull();
  });

  it("accepts CBOR-decoded plain object form", () => {
    const cert = new Uint8Array([9]);
    const unprotected = { [DELEGATION_CERT_LABEL]: cert };
    expect(extractDelegationCertBytes(unprotected)).toEqual(cert);
  });
});

describe("resolveReceiptVerifyKey without delegation cert", () => {
  it("returns custody key only for receipt without header 1000", async () => {
    const { resolveReceiptVerifyKey } = await import(
      "../src/grant/delegation-verify.js"
    );
    const protectedInner = new Uint8Array(encode(new Map([[1, -7]])));
    const receiptBytes = new Uint8Array(
      encode([protectedInner, new Map(), new Uint8Array(0), new Uint8Array(64)]),
    );
    const custody = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    const result = await resolveReceiptVerifyKey(receiptBytes, custody);
    expect(result?.verifyKeys).toHaveLength(1);
    expect(result?.verifyKeys[0]).toBe(custody);
  });
});
