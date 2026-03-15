/**
 * Unit tests for grant-completion helpers (no network).
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { describe, expect, it } from "vitest";
import {
  buildCompletedGrant,
  entryIdToIdtimestamp,
  extractEntryIdFromReceiptUrl,
  HEADER_IDTIMESTAMP,
  HEADER_RECEIPT,
  signerHexFromGrantPayload,
} from "./grant-completion.js";

describe("entryIdToIdtimestamp", () => {
  it("returns first 8 bytes of 32-char hex as big-endian", () => {
    const id = "0123456789abcdef0123456789abcdef";
    const out = entryIdToIdtimestamp(id);
    expect(out.length).toBe(8);
    expect(Array.from(out)).toEqual([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
  });

  it("throws for non-32-hex input", () => {
    expect(() => entryIdToIdtimestamp("short")).toThrow("entryId must be 32 hex");
    expect(() => entryIdToIdtimestamp("x".repeat(32))).toThrow("entryId must be 32 hex");
  });
});

describe("extractEntryIdFromReceiptUrl", () => {
  it("extracts entryId from path .../entries/{entryId}/receipt", () => {
    const url = "https://api.example.com/logs/abc/entries/0123456789abcdef0123456789abcdef/receipt";
    expect(extractEntryIdFromReceiptUrl(url)).toBe("0123456789abcdef0123456789abcdef");
  });

  it("ignores query string", () => {
    const url = "https://api.example.com/logs/x/entries/abcdef0123456789abcdef0123456789/receipt?foo=1";
    expect(extractEntryIdFromReceiptUrl(url)).toBe("abcdef0123456789abcdef0123456789");
  });

  it("throws when receipt segment missing or entryId wrong length", () => {
    expect(() => extractEntryIdFromReceiptUrl("https://api.example.com/other")).toThrow(
      "receipt URL must contain",
    );
    expect(() =>
      extractEntryIdFromReceiptUrl("https://api.example.com/entries/short/receipt"),
    ).toThrow("entryId segment must be 32 hex");
  });
});

describe("signerHexFromGrantPayload", () => {
  it("returns first 32 bytes of key 7 as hex", () => {
    const signer = new Uint8Array(40);
    for (let i = 0; i < 32; i++) signer[i] = i;
    const payload = new Uint8Array(encodeCbor(new Map([[7, signer]])));
    expect(signerHexFromGrantPayload(payload)).toBe(
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    );
  });

  it("throws when key 7 missing or too short", () => {
    const empty = new Uint8Array(encodeCbor(new Map()));
    expect(() => signerHexFromGrantPayload(empty)).toThrow("Grant payload missing signer");
    const short = new Uint8Array(encodeCbor(new Map([[7, new Uint8Array(16)]])));
    expect(() => signerHexFromGrantPayload(short)).toThrow("Grant payload missing signer");
  });
});

describe("buildCompletedGrant", () => {
  it("produces COSE with idtimestamp and receipt in unprotected", () => {
    const entryId = "0123456789abcdef0123456789abcdef";
    const idtimestamp = entryIdToIdtimestamp(entryId);
    const receiptBytes = new Uint8Array([0xca, 0xfe]);
    const protectedHeader = new Uint8Array(encodeCbor(new Map([[1, -7]])));
    const payload = new Uint8Array(encodeCbor(new Map([[7, new Uint8Array(32)]])));
    const signature = new Uint8Array(64);
    const originalCose = [protectedHeader, new Map(), payload, signature];
    const originalBytes = new Uint8Array(encodeCbor(originalCose));
    const originalBase64 = btoa(String.fromCharCode(...originalBytes));

    const receiptUrl = `https://api.example.com/logs/x/entries/${entryId}/receipt`;
    const completedBase64 = buildCompletedGrant(originalBase64, receiptUrl, receiptBytes);

    const completedBytes = Uint8Array.from(atob(completedBase64), (c) => c.charCodeAt(0));
    const completed = decodeCbor(completedBytes) as unknown[];
    expect(completed).toHaveLength(4);
    const unprotected = completed[1] as Map<number, Uint8Array>;
    expect(unprotected).toBeInstanceOf(Map);
    expect(unprotected.get(HEADER_IDTIMESTAMP)).toEqual(idtimestamp);
    expect(unprotected.get(HEADER_RECEIPT)).toEqual(receiptBytes);
  });

  it("throws for invalid grant (not 4-element COSE)", () => {
    const bad = btoa("x");
    expect(() =>
      buildCompletedGrant(
        bad,
        "https://api.example.com/logs/x/entries/0123456789abcdef0123456789abcdef/receipt",
        new Uint8Array(0),
      ),
    ).toThrow();
  });
});
