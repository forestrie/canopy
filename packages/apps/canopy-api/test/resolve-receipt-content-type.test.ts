import { describe, expect, it } from "vitest";

import { CBOR_CONTENT_TYPES } from "../src/cbor-api/cbor-content-types.js";
import { negotiateReceiptContentType } from "../src/scrapi/resolve-receipt";

describe("negotiateReceiptContentType", () => {
  it("returns the draft media type when Accept is missing", () => {
    expect(negotiateReceiptContentType(null)).toBe(
      CBOR_CONTENT_TYPES.SCITT_RECEIPT_COSE,
    );
  });

  it("returns the draft media type for */*", () => {
    expect(negotiateReceiptContentType("*/*")).toBe(
      CBOR_CONTENT_TYPES.SCITT_RECEIPT_COSE,
    );
  });

  it("returns the draft media type for application/cose", () => {
    expect(negotiateReceiptContentType("application/cose")).toBe(
      CBOR_CONTENT_TYPES.SCITT_RECEIPT_COSE,
    );
  });

  it("returns the draft media type for application/cbor", () => {
    expect(negotiateReceiptContentType("application/cbor")).toBe(
      CBOR_CONTENT_TYPES.SCITT_RECEIPT_COSE,
    );
  });

  it("returns the draft media type when Accept already names it", () => {
    expect(negotiateReceiptContentType("application/scitt.receipt+cose")).toBe(
      CBOR_CONTENT_TYPES.SCITT_RECEIPT_COSE,
    );
  });

  it("returns the legacy alias when Accept names it", () => {
    expect(negotiateReceiptContentType("application/scitt-receipt+cbor")).toBe(
      CBOR_CONTENT_TYPES.SCITT_RECEIPT,
    );
  });

  it("matches the legacy alias case-insensitively", () => {
    expect(negotiateReceiptContentType("Application/SCITT-Receipt+CBOR")).toBe(
      CBOR_CONTENT_TYPES.SCITT_RECEIPT,
    );
  });

  it("matches the legacy alias among a comma-separated Accept list", () => {
    expect(
      negotiateReceiptContentType(
        "text/html, application/scitt-receipt+cbor;q=0.9, */*;q=0.1",
      ),
    ).toBe(CBOR_CONTENT_TYPES.SCITT_RECEIPT);
  });

  it("ignores parameters when matching the legacy alias", () => {
    expect(
      negotiateReceiptContentType("application/scitt-receipt+cbor; q=0.5"),
    ).toBe(CBOR_CONTENT_TYPES.SCITT_RECEIPT);
  });

  it("returns the draft media type for an unrelated Accept value", () => {
    expect(negotiateReceiptContentType("text/plain")).toBe(
      CBOR_CONTENT_TYPES.SCITT_RECEIPT_COSE,
    );
  });
});
