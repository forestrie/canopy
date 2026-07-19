/**
 * Protected header CWT claims (FOR-371): label 15 (RFC 9597) carrying
 * `{ 1: iss, 2: sub }` (+ optional iat and extra claims), canonically
 * ordered and byte-compatible with the claims-free shapes.
 */
import cbor from "cbor";
import { describe, expect, it } from "vitest";
import { decodeCborDeterministic } from "./decode-cbor-deterministic.js";
import {
  COSE_ALG,
  COSE_CTY,
  COSE_CWT_CLAIMS,
  COSE_KID,
  CWT_IAT,
  CWT_ISS,
  CWT_SUB,
  encodeCoseProtectedMapBytes,
} from "./encode-cose-protected.js";
import { signCoseSign1Statement } from "./sign-cose-sign1-statement.js";
import {
  COSE_ALG_ES256,
  decodeCoseSign1,
  verifyCoseSign1,
} from "./verify-cose-sign1.js";

function testKid(): Uint8Array {
  const kid = new Uint8Array(32);
  for (let i = 0; i < kid.length; i++) kid[i] = i + 1;
  return kid;
}

function mapGet(decoded: unknown, k: number): unknown {
  return decoded instanceof Map
    ? decoded.get(k)
    : (decoded as Record<number, unknown>)[k];
}

describe("encodeCoseProtectedMapBytes with cwtClaims", () => {
  it("emits canonical {1: alg, 3: cty, 4: kid, 15: {1: iss, 2: sub}}", () => {
    const kid = testKid();
    const got = encodeCoseProtectedMapBytes(kid, {
      alg: COSE_ALG_ES256,
      cty: "application/json",
      cwtClaims: { iss: "issuer-1", sub: "subject-1" },
    });
    // a4 (map 4) 01 26 (1: -7) 03 70 "application/json" 04 58 20 <kid>
    // 0f (15) a2 (map 2) 01 68 "issuer-1" 02 69 "subject-1"
    expect(got[0]).toBe(0xa4);
    // 1 (map hdr) + 2 (01 26) + 18 (03 70 + 16) + 35 (04 58 20 + 32)
    const claimsOffset = 56;
    expect(got[claimsOffset]).toBe(0x0f);
    expect(got[claimsOffset + 1]).toBe(0xa2);
    const decoded = decodeCborDeterministic(got);
    expect(mapGet(decoded, COSE_ALG)).toBe(COSE_ALG_ES256);
    expect(mapGet(decoded, COSE_CTY)).toBe("application/json");
    const claims = mapGet(decoded, COSE_CWT_CLAIMS);
    expect(mapGet(claims, CWT_ISS)).toBe("issuer-1");
    expect(mapGet(claims, CWT_SUB)).toBe("subject-1");
    expect(mapGet(decoded, COSE_KID)).toBeInstanceOf(Uint8Array);
  });

  it("iat (6) and extra claims (e.g. cnf = 8) keep canonical key order", () => {
    const got = encodeCoseProtectedMapBytes(testKid(), {
      cwtClaims: {
        iss: "i",
        sub: "s",
        iat: 1752868800,
        extra: new Map([[8, new Uint8Array([0xaa, 0xbb])]]),
      },
    });
    const claims = mapGet(decodeCborDeterministic(got), COSE_CWT_CLAIMS) as Map<
      number,
      unknown
    >;
    expect([...claims.keys()]).toEqual([CWT_ISS, CWT_SUB, CWT_IAT, 8]);
    expect(mapGet(claims, CWT_IAT)).toBe(1752868800);
    expect(Array.from(mapGet(claims, 8) as Uint8Array)).toEqual([0xaa, 0xbb]);
  });

  it("rejects an extra claim that duplicates a named claim key", () => {
    expect(() =>
      encodeCoseProtectedMapBytes(testKid(), {
        cwtClaims: { iss: "i", extra: new Map([[CWT_ISS, "clash"]]) },
      }),
    ).toThrow(/duplicate CWT claim key/);
  });

  it("rejects an empty claims map", () => {
    expect(() =>
      encodeCoseProtectedMapBytes(testKid(), { cwtClaims: {} }),
    ).toThrow(/at least one claim/);
  });

  it("independent reference decoder agrees on the claims map", () => {
    const got = encodeCoseProtectedMapBytes(testKid(), {
      alg: -7,
      cty: "application/json",
      cwtClaims: { iss: "issuer-1", sub: "subject-1", iat: 1752868800 },
    });
    const decoded = cbor.decodeFirstSync(Buffer.from(got)) as Map<
      number,
      unknown
    >;
    const claims = decoded.get(COSE_CWT_CLAIMS) as Map<number, unknown>;
    expect(claims.get(CWT_ISS)).toBe("issuer-1");
    expect(claims.get(CWT_SUB)).toBe("subject-1");
    expect(claims.get(CWT_IAT)).toBe(1752868800);
    // Reference re-encode (canonical mode) reproduces our bytes exactly.
    const reencoded = cbor.encodeCanonical(decoded) as Buffer;
    expect(Array.from(new Uint8Array(reencoded))).toEqual(Array.from(got));
  });
});

describe("signCoseSign1Statement with cwtClaims", () => {
  it("signature covers the claims; tampering iss fails verification", async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const cose = await signCoseSign1Statement(
      new TextEncoder().encode('{"hello":"world"}'),
      testKid(),
      pair.privateKey,
      {
        alg: COSE_ALG_ES256,
        cty: "application/json",
        cwtClaims: { iss: "issuer-1", sub: "subject-1" },
      },
    );
    expect(cose[0]).toBe(0x84);
    const decoded = decodeCoseSign1(cose)!;
    const claims = mapGet(
      decodeCborDeterministic(decoded.protectedBstr),
      COSE_CWT_CLAIMS,
    );
    expect(mapGet(claims, CWT_ISS)).toBe("issuer-1");
    expect(await verifyCoseSign1(cose, pair.publicKey)).toBe(true);

    // Flip a byte inside the iss text within the protected bstr.
    const issByte = cose.indexOf(0x0f); // label 15 inside protected
    const tampered = new Uint8Array(cose);
    tampered[issByte + 4] ^= 0x01;
    expect(await verifyCoseSign1(tampered, pair.publicKey)).toBe(false);
  });
});
