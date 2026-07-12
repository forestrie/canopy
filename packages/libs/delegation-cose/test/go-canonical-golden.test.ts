/**
 * Cross-repo canonicity guard: the TS delegation builders must emit the exact
 * bytes Go `delegationcert` produces with `cbor.SortCoreDeterministic`
 * (RFC 8949 §4.2). The golden vectors below are asserted byte-for-byte by the
 * Go test `TestCanonicalGolden` in
 * arbor/services/pkgs/delegationcert/canonical_golden_test.go for the identical
 * fixed inputs — if either side changes, delegation-cert signatures stop
 * interoperating (see status-2607-03-remove-cbor-x-for-scitt-cose-canonicity).
 */
import { describe, expect, it } from "vitest";
import { buildDelegationToBeSignedEs256 } from "../src/build-tbs-es256.js";
import { encodeIntKeyCbor } from "../src/encode-int-map.js";

function hex(u8: Uint8Array): string {
  return Buffer.from(u8).toString("hex");
}

/** Fixed COSE_Key (EC2 P-256) matching the Go golden fixture. */
function fixedDelegatedKeyCbor(): Uint8Array {
  const x = new Uint8Array(32).map((_, i) => 0x10 + i);
  const y = new Uint8Array(32).map((_, i) => 0x40 + i);
  return encodeIntKeyCbor(
    new Map<number, unknown>([
      [1, 2], // kty EC2
      [-1, 1], // crv P-256
      [-2, x],
      [-3, y],
    ]),
  );
}

// Golden bytes emitted by Go delegationcert (SortCoreDeterministic).
const GO_PROTECTED =
  "a301260378256170706c69636174696f6e2f666f726573747269652e64656c65676174696f6e2b63626f720450000102030405060708090a0b0c0d0e0f";
const GO_PAYLOAD =
  "a90178206131623263336434653566363738393061626364656631323334353637383930030004183f05a401022001215820101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f225820404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f06a00701081a000f4240091a001e84800a50a0a1a2a3a4a5a6a7a8a9aaabacadaeaf";

describe("delegation TBS matches Go delegationcert canonical golden", () => {
  const kid = new Uint8Array(16).map((_, i) => i);
  const delegationId = new Uint8Array(16).map((_, i) => 0xa0 + i);

  it("protected + payload are byte-for-byte identical to Go", () => {
    const tbs = buildDelegationToBeSignedEs256(
      {
        logIdHex32: "a1b2c3d4e5f67890abcdef1234567890",
        mmrStart: 0,
        mmrEnd: 63,
        delegatedPublicKeyCbor: fixedDelegatedKeyCbor(),
        delegationId,
        issuedAt: 1000000,
        expiresAt: 2000000,
      },
      kid,
    );
    expect(hex(tbs.protectedBytes)).toBe(GO_PROTECTED);
    expect(hex(tbs.payloadBytes)).toBe(GO_PAYLOAD);
  });

  it("no cbor-x extension tags (64 / 259) in the emitted bytes", () => {
    const tbs = buildDelegationToBeSignedEs256(
      {
        logIdHex32: "a1b2c3d4e5f67890abcdef1234567890",
        mmrStart: 0,
        mmrEnd: 63,
        delegatedPublicKeyCbor: fixedDelegatedKeyCbor(),
        delegationId,
        issuedAt: 1000000,
        expiresAt: 2000000,
      },
      kid,
    );
    for (const bytes of [tbs.protectedBytes, tbs.payloadBytes]) {
      expect(hex(bytes)).not.toContain("d840");
      expect(hex(bytes)).not.toContain("d90103");
    }
  });
});
