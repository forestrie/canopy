import { describe, expect, it } from "vitest";
import { decode as decodeCbor } from "cbor-x";
import { decodeCoseSign1 } from "./verify-cose-sign1.js";
import { coseUnprotectedToMap } from "./cose-unprotected-map.js";
import { encodeCoseSign1Raw } from "./encode-cose-sign1-raw.js";
import { mergeUnprotectedIntoCoseSign1 } from "./merge-cose-sign1-unprotected.js";

describe("coseUnprotectedToMap", () => {
  it("maps numeric string keys from plain object", () => {
    const m = coseUnprotectedToMap({
      "4": new Uint8Array([1]),
      "-65537": new Uint8Array(8),
    });
    expect(m.get(4)).toEqual(new Uint8Array([1]));
    expect(m.get(-65537)).toEqual(new Uint8Array(8));
  });

  it("copies Map entries", () => {
    const src = new Map<number, unknown>([[396, new Uint8Array([9, 9])]]);
    const m = coseUnprotectedToMap(src);
    expect(m.get(396)).toEqual(new Uint8Array([9, 9]));
  });
});

describe("encodeCoseSign1Raw + mergeUnprotectedIntoCoseSign1", () => {
  const protectedBstr = new Uint8Array([0xa1, 0x01, 0x38, 0x20]); // minimal fake protected
  const payload = new Uint8Array(32).fill(7);
  const signature = new Uint8Array(64).fill(8);
  const unprot = new Map<number, unknown>([
    [-65538, new Uint8Array([1, 2, 3])],
  ]);

  it("round-trips through decodeCoseSign1", () => {
    const bytes = encodeCoseSign1Raw(protectedBstr, unprot, payload, signature);
    const d = decodeCoseSign1(bytes);
    expect(d).not.toBeNull();
    expect(d!.protectedBstr).toEqual(protectedBstr);
    expect(d!.payloadBstr).toEqual(payload);
    expect(d!.signature).toEqual(signature);
    const u = coseUnprotectedToMap(d!.unprotected);
    expect(u.get(-65538)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("merge adds keys without altering protected, payload, signature", () => {
    const base = encodeCoseSign1Raw(
      protectedBstr,
      new Map<number, unknown>(),
      payload,
      signature,
    );
    const receipt = new Uint8Array([0xde, 0xad]);
    const idts = new Uint8Array(8).fill(3);
    const merged = mergeUnprotectedIntoCoseSign1(
      base,
      new Map<number, unknown>([
        [396, receipt],
        [-65537, idts],
      ]),
    );
    const d = decodeCoseSign1(merged);
    expect(d!.protectedBstr).toEqual(protectedBstr);
    expect(d!.payloadBstr).toEqual(payload);
    expect(d!.signature).toEqual(signature);
    const u = coseUnprotectedToMap(d!.unprotected);
    expect(u.get(396)).toEqual(receipt);
    expect(u.get(-65537)).toEqual(idts);
  });

  it("merge overwrites existing unprotected key", () => {
    const base = encodeCoseSign1Raw(
      protectedBstr,
      new Map<number, unknown>([[396, new Uint8Array([1])]]),
      payload,
      signature,
    );
    const merged = mergeUnprotectedIntoCoseSign1(
      base,
      new Map<number, unknown>([[396, new Uint8Array([2, 2])]]),
    );
    const u = coseUnprotectedToMap(decodeCoseSign1(merged)!.unprotected);
    expect(u.get(396)).toEqual(new Uint8Array([2, 2]));
  });

  it("throws on invalid Sign1 bytes", () => {
    expect(() =>
      mergeUnprotectedIntoCoseSign1(new Uint8Array([0xff]), new Map()),
    ).toThrow(/invalid COSE Sign1/);
  });
});
