import { describe, expect, it } from "vitest";
import { queryRegistrationOnce, resolveReceiptOnce } from "../src/index.js";

const BASE = "https://logs.example.test";
const STATUS_URL = `${BASE}/logs/b/l/entries/inner`;
const ENTRY_ID = "0123456789abcdef0123456789abcdef";
const RECEIPT_LOCATION = `/logs/b/l/14/entries/${ENTRY_ID}/receipt`;

function fetchReturning(response: Response): typeof fetch {
  return (async () => response) as typeof fetch;
}

describe("queryRegistrationOnce", () => {
  it("maps a receipt redirect to status receipt with entryIdHex", async () => {
    const res = new Response(null, {
      status: 303,
      headers: { Location: RECEIPT_LOCATION },
    });
    const out = await queryRegistrationOnce({
      statusUrl: STATUS_URL,
      baseUrl: BASE,
      fetchImpl: fetchReturning(res),
    });
    expect(out).toEqual({
      status: "receipt",
      receiptUrl: `${BASE}${RECEIPT_LOCATION}`,
      entryIdHex: ENTRY_ID,
    });
  });

  it("maps a non-receipt redirect to pending, honouring Retry-After", async () => {
    const res = new Response(null, {
      status: 303,
      headers: { Location: STATUS_URL, "Retry-After": "2" },
    });
    const out = await queryRegistrationOnce({
      statusUrl: STATUS_URL,
      baseUrl: BASE,
      fetchImpl: fetchReturning(res),
    });
    expect(out).toEqual({
      status: "pending",
      location: STATUS_URL,
      retryAfterMs: 2000,
    });
  });

  it("maps a non-303 to error", async () => {
    const res = new Response(null, { status: 500 });
    const out = await queryRegistrationOnce({
      statusUrl: STATUS_URL,
      baseUrl: BASE,
      fetchImpl: fetchReturning(res),
    });
    expect(out.status).toBe("error");
    if (out.status === "error") expect(out.httpStatus).toBe(500);
  });

  it("maps a 303 without Location to error", async () => {
    const res = new Response(null, { status: 303 });
    const out = await queryRegistrationOnce({
      statusUrl: STATUS_URL,
      baseUrl: BASE,
      fetchImpl: fetchReturning(res),
    });
    expect(out).toEqual({
      status: "error",
      httpStatus: 303,
      detail: "303 without Location",
    });
  });
});

describe("resolveReceiptOnce", () => {
  it("returns the receipt body on 200", async () => {
    const body = new Uint8Array([0xd2, 0x84]);
    const res = new Response(body, {
      status: 200,
      headers: { "content-type": "application/cbor" },
    });
    const out = await resolveReceiptOnce({
      receiptUrl: `${BASE}${RECEIPT_LOCATION}`,
      fetchImpl: fetchReturning(res),
    });
    expect(out.status).toBe("receipt");
    if (out.status === "receipt") {
      expect(out.httpStatus).toBe(200);
      expect(out.body).toEqual(body);
      expect(out.headers["content-type"]).toBe("application/cbor");
    }
  });

  it("treats 404 as pending (R2 may lag)", async () => {
    const out = await resolveReceiptOnce({
      receiptUrl: `${BASE}${RECEIPT_LOCATION}`,
      fetchImpl: fetchReturning(new Response(null, { status: 404 })),
    });
    expect(out).toEqual({ status: "pending" });
  });

  it("maps other statuses to error", async () => {
    const out = await resolveReceiptOnce({
      receiptUrl: `${BASE}${RECEIPT_LOCATION}`,
      fetchImpl: fetchReturning(new Response(null, { status: 500 })),
    });
    expect(out).toEqual({ status: "error", httpStatus: 500 });
  });
});
