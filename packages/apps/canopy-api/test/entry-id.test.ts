import { describe, expect, it } from "vitest";

import {
  decodeEntryId,
  encodeEntryId,
  isEntryIdHex,
} from "../src/scrapi/entry-id";

describe("entryId", () => {
  it("encodes and decodes (idtimestamp, mmrIndex)", () => {
    const idtimestamp = 0x0102030405060708n;
    const mmrIndex = 0x1112131415161718n;

    const entryId = encodeEntryId({ idtimestamp, mmrIndex });
    expect(entryId).toBe("01020304050607081112131415161718");
    expect(isEntryIdHex(entryId)).toBe(true);

    const decoded = decodeEntryId(entryId);
    expect(decoded.idtimestamp).toBe(idtimestamp);
    expect(decoded.mmrIndex).toBe(mmrIndex);
  });

  it("rejects non-hex and wrong length", () => {
    expect(isEntryIdHex("")).toBe(false);
    expect(isEntryIdHex("ab")).toBe(false);
    expect(isEntryIdHex("z".repeat(32))).toBe(false);

    expect(() => decodeEntryId("ab")).toThrow(
      /entryId must be exactly 16 bytes/i,
    );
    expect(() => decodeEntryId("z".repeat(32))).toThrow(/entryId must be/i);
  });
});
