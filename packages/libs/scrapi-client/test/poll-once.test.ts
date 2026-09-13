import { encodeCborDeterministic } from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
import {
  queryRegistrationOnce,
  queryRegistrationRaw,
  resolveReceiptOnce,
  resolveReceiptRaw,
} from "../src/index.js";

const BASE = "https://logs.example.test";
const STATUS_URL = `${BASE}/logs/b/l/entries/inner`;
const ENTRY_ID = "0123456789abcdef0123456789abcdef";
const RECEIPT_LOCATION = `/logs/b/l/14/entries/${ENTRY_ID}/receipt`;
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fetchReturning(response: Response): typeof fetch {
  return (async () => response) as typeof fetch;
}

interface CapturedFetch {
  url: string | undefined;
  init: RequestInit | undefined;
}

function fetchCapturing(
  response: Response,
  captured: CapturedFetch,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.init = init;
    return response;
  }) as typeof fetch;
}

describe("queryRegistrationRaw", () => {
  it("returns the raw exchange for every status, using redirect: manual", async () => {
    const captured: CapturedFetch = { url: undefined, init: undefined };
    const res = new Response(null, {
      status: 303,
      headers: { Location: RECEIPT_LOCATION, "X-Extra": "one" },
    });
    const raw = await queryRegistrationRaw({
      statusUrl: STATUS_URL,
      fetchImpl: fetchCapturing(res, captured),
    });
    expect(raw.url).toBe(STATUS_URL);
    expect(raw.status).toBe(303);
    expect(raw.headers["location"]).toBe(RECEIPT_LOCATION);
    expect(raw.headers["x-extra"]).toBe("one");
    expect(raw.body).toEqual(new Uint8Array(0));
    expect(raw.at).toMatch(ISO_8601_RE);
    expect(new Date(raw.at).toISOString()).toBe(raw.at);
    expect(captured.url).toBe(STATUS_URL);
    expect(captured.init?.redirect).toBe("manual");
  });
});

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

  it("decodes problem details on a synthetic application/problem+cbor error body", async () => {
    const problem = { title: "conflict", status: 409, detail: "already open" };
    const res = new Response(encodeCborDeterministic(problem) as BodyInit, {
      status: 409,
      headers: { "content-type": "application/problem+cbor" },
    });
    const out = await queryRegistrationOnce({
      statusUrl: STATUS_URL,
      baseUrl: BASE,
      fetchImpl: fetchReturning(res),
    });
    expect(out.status).toBe("error");
    if (out.status === "error") {
      expect(out.httpStatus).toBe(409);
      expect(out.problem?.title).toBe("conflict");
      expect(out.problem?.detail).toBe("already open");
    }
  });
});

describe("resolveReceiptRaw", () => {
  it("returns the raw exchange for every status, using redirect: manual", async () => {
    const captured: CapturedFetch = { url: undefined, init: undefined };
    const body = new Uint8Array([0xd2, 0x84]);
    const res = new Response(body, {
      status: 200,
      headers: { "content-type": "application/cbor" },
    });
    const receiptUrl = `${BASE}${RECEIPT_LOCATION}`;
    const raw = await resolveReceiptRaw({
      receiptUrl,
      fetchImpl: fetchCapturing(res, captured),
    });
    expect(raw.url).toBe(receiptUrl);
    expect(raw.status).toBe(200);
    expect(raw.headers["content-type"]).toBe("application/cbor");
    expect(raw.body).toEqual(body);
    expect(raw.at).toMatch(ISO_8601_RE);
    expect(new Date(raw.at).toISOString()).toBe(raw.at);
    expect(captured.init?.redirect).toBe("manual");
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

  it("reports not_found on a synthetic 404 on the receipt route", async () => {
    const out = await resolveReceiptOnce({
      receiptUrl: `${BASE}${RECEIPT_LOCATION}`,
      fetchImpl: fetchReturning(new Response(null, { status: 404 })),
    });
    expect(out).toEqual({ status: "not_found" });
  });

  it("maps other statuses to error", async () => {
    const out = await resolveReceiptOnce({
      receiptUrl: `${BASE}${RECEIPT_LOCATION}`,
      fetchImpl: fetchReturning(new Response(null, { status: 500 })),
    });
    expect(out).toEqual({ status: "error", httpStatus: 500 });
  });

  it("decodes problem details on a synthetic application/problem+cbor error body", async () => {
    const problem = { title: "boom", status: 500, detail: "synthetic" };
    const res = new Response(encodeCborDeterministic(problem) as BodyInit, {
      status: 500,
      headers: { "content-type": "application/problem+cbor" },
    });
    const out = await resolveReceiptOnce({
      receiptUrl: `${BASE}${RECEIPT_LOCATION}`,
      fetchImpl: fetchReturning(res),
    });
    expect(out.status).toBe("error");
    if (out.status === "error") {
      expect(out.httpStatus).toBe(500);
      expect(out.problem?.title).toBe("boom");
      expect(out.problem?.detail).toBe("synthetic");
    }
  });
});
