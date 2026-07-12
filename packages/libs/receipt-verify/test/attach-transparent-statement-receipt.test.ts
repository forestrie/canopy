/**
 * Deterministic receipt create/attach helpers (FOR-353). Golden vectors for
 * receipt construction/verification are tracked by FOR-289.
 */
import { describe, expect, it } from "vitest";
import {
  coseUnprotectedToMap,
  decodeCoseSign1,
  encodeCoseSign1Raw,
} from "@forestrie/encoding";
import {
  HEADER_RECEIPT,
  attachReceiptAndIdtimestampToTransparentStatement,
  decodeEntryIdHex,
  entryIdHexToIdtimestampBe8,
} from "../src/index.js";

const HEADER_IDTIMESTAMP = -65537;

describe("attachReceiptAndIdtimestampToTransparentStatement", () => {
  const protectedBstr = new Uint8Array([0xa1, 0x01, 0x26]);
  const payload = new Uint8Array(32).fill(7);
  const signature = new Uint8Array(64).fill(8);

  it("attaches receipt and idtimestamp without altering signed bytes", () => {
    const statement = encodeCoseSign1Raw(
      protectedBstr,
      new Map<number, unknown>(),
      payload,
      signature,
    );
    const receipt = new Uint8Array([0xd2, 0x84, 0x01]);
    const idts = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const completed = attachReceiptAndIdtimestampToTransparentStatement(
      statement,
      receipt,
      idts,
    );
    const decoded = decodeCoseSign1(completed);
    expect(decoded!.protectedBstr).toEqual(protectedBstr);
    expect(decoded!.payloadBstr).toEqual(payload);
    expect(decoded!.signature).toEqual(signature);
    const unprotected = coseUnprotectedToMap(decoded!.unprotected);
    expect(unprotected.get(HEADER_RECEIPT)).toEqual(receipt);
    expect(unprotected.get(HEADER_IDTIMESTAMP)).toEqual(idts);
  });

  it("rejects an idtimestamp that is not 8 bytes", () => {
    expect(() =>
      attachReceiptAndIdtimestampToTransparentStatement(
        new Uint8Array([0x84]),
        new Uint8Array(0),
        new Uint8Array(4),
      ),
    ).toThrow(/idtimestamp must be 8 bytes/);
  });
});

describe("entryId decoding", () => {
  it("splits entryId into idtimestamp and mmrIndex", () => {
    const entryIdHex = "00000000000004d2000000000000162e";
    const { idtimestamp, mmrIndex } = decodeEntryIdHex(entryIdHex);
    expect(idtimestamp).toBe(1234n);
    expect(mmrIndex).toBe(5678n);
  });

  it("entryIdHexToIdtimestampBe8 returns the first 8 bytes big-endian", () => {
    const entryIdHex = "0102030405060708000000000000162e";
    expect(entryIdHexToIdtimestampBe8(entryIdHex)).toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    );
  });

  it("rejects a malformed entryId", () => {
    expect(() => decodeEntryIdHex("not-hex")).toThrow(
      /entryId must be 32 lowercase hex chars/,
    );
  });
});
