/** Golden-vector tests: kit copy of @forestrie/encoding merge-cose-sign1-unprotected. */
import { describe, expect, it } from "vitest";
import { decodeCoseSign1 } from "../src/encoding/verify-cose-sign1.js";
import { coseUnprotectedToMap } from "../src/encoding/cose-unprotected-map.js";
import { encodeCoseSign1Raw } from "../src/encoding/encode-cose-sign1-raw.js";
import { mergeUnprotectedIntoCoseSign1 } from "../src/encoding/merge-cose-sign1-unprotected.js";

describe("encodeCoseSign1Raw + mergeUnprotectedIntoCoseSign1 (kit drift guard)", () => {
  const protectedBstr = new Uint8Array([0xa1, 0x01, 0x38, 0x20]);
  const payload = new Uint8Array(32).fill(7);
  const signature = new Uint8Array(64).fill(8);

  it("merge adds receipt and idtimestamp without altering signed bytes", () => {
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
});
