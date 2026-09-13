import { describe, expect, it } from "vitest";

import {
  SCITT_RECEIPT_COSE_CONTENT_TYPE,
  resolveReceiptOnce,
  resolveReceiptRaw,
} from "../src/index.js";

const RECEIPT_URL = "https://logs.example.test/logs/aa/bb/8/entries/cc/receipt";

interface Captured {
  url: string;
  init: RequestInit;
}

function mockFetch(
  response: Response,
  captured: Captured[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return response;
  }) as typeof fetch;
}

describe("resolveReceiptRaw", () => {
  it("defaults Accept to the draft SCITT Receipt media type (FOR-559)", async () => {
    expect(SCITT_RECEIPT_COSE_CONTENT_TYPE).toBe(
      "application/scitt.receipt+cose",
    );

    const captured: Captured[] = [];
    const res = new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    await resolveReceiptRaw({
      receiptUrl: RECEIPT_URL,
      fetchImpl: mockFetch(res, captured),
    });
    expect(
      (captured[0]!.init.headers as Record<string, string>)["Accept"],
    ).toBe(SCITT_RECEIPT_COSE_CONTENT_TYPE);
    expect(captured[0]!.init.redirect).toBe("manual");
  });

  it("honours an explicit accept option override", async () => {
    const captured: Captured[] = [];
    const res = new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    await resolveReceiptRaw({
      receiptUrl: RECEIPT_URL,
      accept: "application/scitt-receipt+cbor",
      fetchImpl: mockFetch(res, captured),
    });
    expect(
      (captured[0]!.init.headers as Record<string, string>)["Accept"],
    ).toBe("application/scitt-receipt+cbor");
  });
});

describe("resolveReceiptOnce", () => {
  it("sends the draft Accept by default and returns the receipt body", async () => {
    const captured: Captured[] = [];
    const body = new Uint8Array([1, 2, 3]);
    const res = new Response(body, {
      status: 200,
      headers: { "content-type": SCITT_RECEIPT_COSE_CONTENT_TYPE },
    });
    const out = await resolveReceiptOnce({
      receiptUrl: RECEIPT_URL,
      fetchImpl: mockFetch(res, captured),
    });
    expect(
      (captured[0]!.init.headers as Record<string, string>)["Accept"],
    ).toBe(SCITT_RECEIPT_COSE_CONTENT_TYPE);
    expect(out.status).toBe("receipt");
    if (out.status === "receipt") {
      expect(out.body).toEqual(body);
    }
  });
});
