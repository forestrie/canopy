/**
 * `readProtectedAlg`: a protected header with no integer `alg` (label 1) is
 * rejected, matching the univocity contract's reader (review finding S-1).
 *
 * The three headers are the ones the finding's probe fed to both sides: a
 * canonical checkpoint header, the same header with label 1 removed, and the
 * same header with a byte string under label 1. The contract answers the
 * last two with `ClaimNotFound(1)` and `UnexpectedMajorType`; the lenient
 * `extractAlgFromProtected` answers both with `null`, which is why a check
 * conditioned on the algorithm must not be built on it.
 */
import { describe, expect, it } from "vitest";
import {
  COSE_ALG_ES256,
  ProtectedHeaderAlgError,
  extractAlgFromProtected,
  readProtectedAlg,
} from "./verify-cose-sign1.js";

const fromHex = (h: string) =>
  new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));

/** `{1: -7, 395: 3, -65933: 8}` — a checkpoint header as the sealer emits it. */
const CANONICAL = fromHex("a3012619018b033a0001018c08");
/** The same header with label 1 absent: `{395: 3, -65933: 8}`. */
const NO_ALG = fromHex("a219018b033a0001018c08");
/** The same header with a byte string under label 1: `{1: h'26', …}`. */
const BSTR_ALG = fromHex("a301412619018b033a0001018c08");

describe("readProtectedAlg", () => {
  it("reads the alg from a canonical header", () => {
    expect(readProtectedAlg(CANONICAL)).toBe(COSE_ALG_ES256);
  });

  it("rejects a header with no label 1", () => {
    expect(() => readProtectedAlg(NO_ALG)).toThrow(ProtectedHeaderAlgError);
    expect(() => readProtectedAlg(NO_ALG)).toThrow(/no alg/);
  });

  it("rejects a byte string under label 1", () => {
    expect(() => readProtectedAlg(BSTR_ALG)).toThrow(ProtectedHeaderAlgError);
    expect(() => readProtectedAlg(BSTR_ALG)).toThrow(/not an integer/);
  });

  it("rejects an empty protected header", () => {
    expect(() => readProtectedAlg(new Uint8Array(0))).toThrow(
      ProtectedHeaderAlgError,
    );
  });

  it("rejects bytes that are not decodable CBOR", () => {
    expect(() => readProtectedAlg(fromHex("a301"))).toThrow(
      ProtectedHeaderAlgError,
    );
  });

  it("rejects a header that is not a CBOR map", () => {
    // `[1, -7]` — an array, not the map a protected header must be.
    expect(() => readProtectedAlg(fromHex("820126"))).toThrow(
      ProtectedHeaderAlgError,
    );
  });

  it("is the strict sibling of the lenient reader", () => {
    // The lenient reader answers null for both rejected headers, which is
    // the condition the finding reports: a check gated on the algorithm is
    // switched off by a header the contract will not accept.
    expect(extractAlgFromProtected(NO_ALG)).toBeNull();
    expect(extractAlgFromProtected(BSTR_ALG)).toBeNull();
    expect(extractAlgFromProtected(CANONICAL)).toBe(COSE_ALG_ES256);
  });
});
