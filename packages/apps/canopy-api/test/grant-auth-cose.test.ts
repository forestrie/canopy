/**
 * Grant-auth COSE Sign1 encode/decode and signer match tests.
 *
 * Minimal reproduction of the sign/verify and encode/decode path used by
 * k6 (encodeCoseSign1WithKid) and the API (getSignerFromCoseSign1,
 * signerMatchesGrant). Ensures roundtrip and grant signer matching behave
 * as expected. Includes cryptographic verification (Plan 0003).
 */

import {
  getSignerFromCoseSign1,
  signerMatchesGrant,
} from "../src/scrapi/grant-auth";
import {
  encodeCoseSign1Statement,
  signCoseSign1Statement,
  verifyCoseSign1,
} from "@canopy/encoding";
import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { describe, expect, it } from "vitest";
import { encodeCoseSign1WithKid } from "./cose-sign1-k6-encoder";

describe("COSE Sign1 with kid (k6-compatible encode / API decode)", () => {
  const signer32 = new Uint8Array(32);
  for (let i = 0; i < 32; i++) signer32[i] = i + 1;

  it("roundtrips: encoded kid equals decoded signer", () => {
    const payload = new TextEncoder().encode("test payload");
    const coseSign1 = encodeCoseSign1WithKid(payload, signer32);
    const decoded = getSignerFromCoseSign1(coseSign1);
    expect(decoded).not.toBeNull();
    expect(decoded!.length).toBe(32);
    expect(decoded!).toEqual(signer32);
  });

  it("signerMatchesGrant returns true when signer bytes match", () => {
    const payload = new Uint8Array(64);
    const coseSign1 = encodeCoseSign1WithKid(payload, signer32);
    const statementSigner = getSignerFromCoseSign1(coseSign1);
    expect(signerMatchesGrant(statementSigner, signer32)).toBe(true);
  });

  it("signerMatchesGrant returns false when signer bytes differ", () => {
    const otherSigner = new Uint8Array(32);
    otherSigner[0] = 0xff;
    const payload = new Uint8Array(64);
    const coseSign1 = encodeCoseSign1WithKid(payload, signer32);
    const statementSigner = getSignerFromCoseSign1(coseSign1);
    expect(signerMatchesGrant(statementSigner, otherSigner)).toBe(false);
  });

  it("signerMatchesGrant returns false when statement signer is null", () => {
    expect(signerMatchesGrant(null, signer32)).toBe(false);
  });

  it("signerMatchesGrant returns false when lengths differ", () => {
    const shortSigner = new Uint8Array(16);
    const coseSign1 = encodeCoseSign1WithKid(new Uint8Array(0), signer32);
    const statementSigner = getSignerFromCoseSign1(coseSign1);
    expect(signerMatchesGrant(statementSigner, shortSigner)).toBe(false);
  });

  it("getSignerFromCoseSign1 returns null for invalid COSE", () => {
    expect(getSignerFromCoseSign1(new Uint8Array(0))).toBeNull();
    expect(
      getSignerFromCoseSign1(new Uint8Array([0x01, 0x02, 0x03])),
    ).toBeNull();
  });

  it("getSignerFromCoseSign1 returns null for COSE with empty protected (no kid)", () => {
    // COSE Sign1: [ protected=0x40 (empty bstr), unprotected=0xa0, payload=0x40, signature=64 bytes ]
    const emptyProtected = new Uint8Array([
      0x84,
      0x40,
      0xa0,
      0x40,
      ...new Array(64).fill(0),
    ]);
    expect(getSignerFromCoseSign1(emptyProtected)).toBeNull();
  });

  it("roundtrips when COSE is built with cbor-x (API encoder compatibility)", () => {
    const payload = new Uint8Array(64);
    const protectedMapBytes = encodeCbor({ 4: signer32 });
    const unprotected = {};
    const signature = new Uint8Array(64);
    const coseSign1 = encodeCbor([
      protectedMapBytes,
      unprotected,
      payload,
      signature,
    ]);
    const decoded = getSignerFromCoseSign1(new Uint8Array(coseSign1));
    expect(decoded).not.toBeNull();
    expect(decoded!).toEqual(signer32);
    expect(signerMatchesGrant(decoded, signer32)).toBe(true);
  });
});

describe("COSE Sign1 encoding: k6 vs cbor-x byte layout", () => {
  const signer32 = new Uint8Array(32);
  for (let i = 0; i < 32; i++) signer32[i] = i + 1;

  it("inspect k6-encoder protected header bytes vs cbor-x", () => {
    const payload = new Uint8Array(0);
    const k6Cose = encodeCoseSign1WithKid(payload, signer32);
    expect(k6Cose.length).toBeGreaterThan(0);
    expect(k6Cose[0]).toBe(0x84);
    const k6ProtectedLen = k6Cose[1] === 0x58 ? k6Cose[2] : k6Cose[1] & 0x1f;
    const k6ProtectedStart = k6Cose[1] === 0x58 ? 3 : 2;
    const k6Protected = k6Cose.slice(
      k6ProtectedStart,
      k6ProtectedStart + k6ProtectedLen,
    );
    const decodedK6Protected = decodeCbor(k6Protected);
    expect(decodedK6Protected).toBeDefined();
    const kidFromK6 =
      decodedK6Protected instanceof Map
        ? decodedK6Protected.get(4)
        : (decodedK6Protected as Record<number, unknown>)[4];
    expect(kidFromK6).toBeDefined();
    expect(kidFromK6 instanceof Uint8Array && kidFromK6.length === 32).toBe(
      true,
    );
    if (kidFromK6 instanceof Uint8Array) {
      expect(kidFromK6).toEqual(signer32);
    }
  });

  it("getSignerFromCoseSign1: first element type when decoding k6 COSE", () => {
    const payload = new Uint8Array(0);
    const k6Cose = encodeCoseSign1WithKid(payload, signer32);
    const arr = decodeCbor(k6Cose) as unknown[];
    expect(Array.isArray(arr) && arr.length >= 4).toBe(true);
    const first = arr[0];
    expect(first).toBeDefined();
    expect(first instanceof Uint8Array).toBe(true);
  });
});

describe("COSE Sign1 cryptographic verification", () => {
  it("verifyCoseSign1 returns false for placeholder signature", async () => {
    const keyPair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const kid = new Uint8Array(32).fill(1);
    const payload = new TextEncoder().encode("test");
    const cosePlaceholder = encodeCoseSign1Statement(
      payload,
      kid,
      new Uint8Array(64),
    );
    const ok = await verifyCoseSign1(cosePlaceholder, keyPair.publicKey);
    expect(ok).toBe(false);
  });

  it("sign then verify returns true (ES256)", async () => {
    const keyPair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const kid = new Uint8Array(32).fill(2);
    const payload = new TextEncoder().encode("statement payload");
    const coseSigned = await signCoseSign1Statement(
      payload,
      kid,
      keyPair.privateKey,
    );
    const ok = await verifyCoseSign1(coseSigned, keyPair.publicKey);
    expect(ok).toBe(true);
    const decodedKid = getSignerFromCoseSign1(coseSigned);
    expect(decodedKid).toEqual(kid);
  });
});
