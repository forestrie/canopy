/**
 * Protected header with `{ 1: alg, 3: cty, 4: kid }` (FOR-341 F1): all
 * interpretable labels signed, canonical ordering, and byte-level backwards
 * compatibility with the historical kid-only shape.
 */
import { describe, expect, it } from "vitest";
import { decodeCborDeterministic } from "./decode-cbor-deterministic.js";
import {
  COSE_ALG,
  COSE_CTY,
  COSE_KID,
  encodeCoseProtectedMapBytes,
} from "./encode-cose-protected.js";
import { decodeCoseSign1 } from "./verify-cose-sign1.js";
import { COSE_ALG_ES256, verifyCoseSign1 } from "./verify-cose-sign1.js";
import { extractAlgFromProtected } from "./verify-cose-sign1.js";
import { signCoseSign1Statement } from "./sign-cose-sign1-statement.js";

function testKid(): Uint8Array {
  const kid = new Uint8Array(32);
  for (let i = 0; i < kid.length; i++) kid[i] = i + 1;
  return kid;
}

describe("encodeCoseProtectedMapBytes with alg/cty", () => {
  it("no options is byte-identical to the kid-only map (backwards compat)", () => {
    const kid = testKid();
    const got = encodeCoseProtectedMapBytes(kid);
    // a1 04 58 20 <kid> — map(1), key 4, bstr(32)
    expect(got[0]).toBe(0xa1);
    expect(got[1]).toBe(0x04);
    expect(got[2]).toBe(0x58);
    expect(got[3]).toBe(0x20);
    expect(Array.from(got.subarray(4))).toEqual(Array.from(kid));
  });

  it("emits canonical {1: alg, 3: cty, 4: kid} with ascending keys", () => {
    const kid = testKid();
    const got = encodeCoseProtectedMapBytes(kid, {
      alg: COSE_ALG_ES256,
      cty: "application/json",
    });
    // a3 (map 3) 01 26 (1: -7) 03 70 "application/json" 04 58 20 <kid>
    expect(got[0]).toBe(0xa3);
    expect(got[1]).toBe(0x01);
    expect(got[2]).toBe(0x26); // -7
    expect(got[3]).toBe(0x03);
    expect(got[4]).toBe(0x70); // tstr(16)
    const decoded = decodeCborDeterministic(got) as
      | Map<number, unknown>
      | Record<number, unknown>;
    const get = (k: number) =>
      decoded instanceof Map
        ? decoded.get(k)
        : (decoded as Record<number, unknown>)[k];
    expect(get(COSE_ALG)).toBe(-7);
    expect(get(COSE_CTY)).toBe("application/json");
    expect(get(COSE_KID)).toBeInstanceOf(Uint8Array);
    expect(extractAlgFromProtected(got)).toBe(COSE_ALG_ES256);
  });

  it("supports uint cty (CoAP content-format)", () => {
    const got = encodeCoseProtectedMapBytes(testKid(), { alg: -7, cty: 60 });
    const decoded = decodeCborDeterministic(got) as Map<number, unknown>;
    const cty =
      decoded instanceof Map
        ? decoded.get(COSE_CTY)
        : (decoded as Record<number, unknown>)[COSE_CTY];
    expect(cty).toBe(60);
  });

  it("rejects non-integer alg", () => {
    expect(() =>
      encodeCoseProtectedMapBytes(testKid(), { alg: -7.5 }),
    ).toThrow();
  });
});

describe("signCoseSign1Statement with protected alg/cty", () => {
  it("signature covers alg/cty/kid; verifies over the received protected bstr", async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;

    const payload = new TextEncoder().encode('{"hello":"world"}');
    const kid = testKid();
    const cose = await signCoseSign1Statement(payload, kid, pair.privateKey, {
      alg: COSE_ALG_ES256,
      cty: "application/json",
    });

    // Wire stays plain untagged COSE Sign1: array(4).
    expect(cose[0]).toBe(0x84);

    const decoded = decodeCoseSign1(cose);
    expect(decoded).not.toBeNull();
    const protectedMap = decodeCborDeterministic(decoded!.protectedBstr) as
      | Map<number, unknown>
      | Record<number, unknown>;
    const get = (k: number) =>
      protectedMap instanceof Map
        ? protectedMap.get(k)
        : (protectedMap as Record<number, unknown>)[k];
    expect(get(COSE_ALG)).toBe(COSE_ALG_ES256);
    expect(get(COSE_CTY)).toBe("application/json");
    expect(Array.from(get(COSE_KID) as Uint8Array)).toEqual(Array.from(kid));
    // Unprotected header carries nothing interpretable.
    const unprotected = decoded!.unprotected;
    const unprotectedSize =
      unprotected instanceof Map
        ? unprotected.size
        : Object.keys(unprotected ?? {}).length;
    expect(unprotectedSize).toBe(0);

    expect(await verifyCoseSign1(cose, pair.publicKey)).toBe(true);

    // Flipping a protected byte (the cty region) invalidates the signature.
    const tampered = new Uint8Array(cose);
    tampered[6] ^= 0x01; // inside protected bstr
    expect(await verifyCoseSign1(tampered, pair.publicKey)).toBe(false);
  });

  it("kid-only signing path is unchanged and still verifies", async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const cose = await signCoseSign1Statement(
      new Uint8Array([1, 2, 3]),
      testKid(),
      pair.privateKey,
    );
    const decoded = decodeCoseSign1(cose)!;
    // protected map is exactly { 4: kid } — a1 04 ...
    expect(decoded.protectedBstr[0]).toBe(0xa1);
    expect(decoded.protectedBstr[1]).toBe(0x04);
    expect(await verifyCoseSign1(cose, pair.publicKey)).toBe(true);
  });
});
