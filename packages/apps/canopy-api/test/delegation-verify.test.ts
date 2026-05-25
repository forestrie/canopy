/**
 * Unit tests for delegation certificate extraction (no Workers pool).
 */

import { describe, expect, it } from "vitest";

import {
  DELEGATION_CERT_LABEL,
  extractDelegationCertBytes,
} from "../src/grant/delegation-verify.js";

describe("extractDelegationCertBytes", () => {
  it("returns cert bytes from unprotected header label 1000", () => {
    const cert = new Uint8Array([1, 2, 3, 4]);
    const unprotected = new Map<number, unknown>([
      [DELEGATION_CERT_LABEL, cert],
    ]);
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
