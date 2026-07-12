import { describe, expect, it } from "vitest";
import {
  decodeCborDeterministic,
  encodeCborDeterministic,
} from "@forestrie/encoding";
import {
  COSE_SIGN1_CONTENT_TYPE,
  ScrapiRegistrationError,
  forestrieGrantAuthorization,
  registerGrant,
  registerSignedStatement,
} from "../src/index.js";

const BASE = "https://logs.example.test";
const BOOTSTRAP = "0198c1a2-3b4c-7d5e-8f60-718293a4b5c6";
const GRANT_B64 = "hEOhASZBoA==";

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

describe("registerGrant", () => {
  it("returns the absolute status URL from a 303 Location", async () => {
    const captured: Captured[] = [];
    const res = new Response(null, {
      status: 303,
      headers: { Location: `/logs/${BOOTSTRAP}/${BOOTSTRAP}/entries/aa` },
    });
    const { statusUrl } = await registerGrant({
      baseUrl: BASE,
      bootstrapLogId: BOOTSTRAP,
      grantBase64: GRANT_B64,
      fetchImpl: mockFetch(res, captured),
    });
    expect(statusUrl).toBe(`${BASE}/logs/${BOOTSTRAP}/${BOOTSTRAP}/entries/aa`);
    expect(captured[0]!.url).toBe(`${BASE}/register/${BOOTSTRAP}/grants`);
    expect(captured[0]!.init.method).toBe("POST");
    expect(captured[0]!.init.redirect).toBe("manual");
    expect(
      (captured[0]!.init.headers as Record<string, string>)["Authorization"],
    ).toBe(forestrieGrantAuthorization(GRANT_B64));
  });

  it("sends the parent grant as a CBOR body", async () => {
    const captured: Captured[] = [];
    const res = new Response(null, {
      status: 303,
      headers: { Location: "/x" },
    });
    const parentBytes = new Uint8Array([1, 2, 3, 4]);
    const parentGrantBase64 = btoa(String.fromCharCode(...parentBytes));
    await registerGrant({
      baseUrl: BASE,
      bootstrapLogId: BOOTSTRAP,
      grantBase64: GRANT_B64,
      parentGrantBase64,
      fetchImpl: mockFetch(res, captured),
    });
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/cbor");
    const body = captured[0]!.init.body as Uint8Array;
    const decoded = decodeCborDeterministic(body) as Map<string, Uint8Array>;
    expect(new Uint8Array(decoded.get("parentGrant")!)).toEqual(parentBytes);
  });

  it("raises ScrapiRegistrationError with problem details on non-303", async () => {
    const problem = { title: "conflict", status: 409, detail: "already open" };
    const res = new Response(encodeCborDeterministic(problem) as BodyInit, {
      status: 409,
    });
    const err = await registerGrant({
      baseUrl: BASE,
      bootstrapLogId: BOOTSTRAP,
      grantBase64: GRANT_B64,
      fetchImpl: mockFetch(res),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScrapiRegistrationError);
    const e = err as ScrapiRegistrationError;
    expect(e.httpStatus).toBe(409);
    expect(e.detail).toBe("already open");
    expect(e.problem?.title).toBe("conflict");
  });

  it("raises ScrapiRegistrationError on 303 without Location", async () => {
    const res = new Response(null, { status: 303 });
    const err = await registerGrant({
      baseUrl: BASE,
      bootstrapLogId: BOOTSTRAP,
      grantBase64: GRANT_B64,
      fetchImpl: mockFetch(res),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScrapiRegistrationError);
    expect((err as ScrapiRegistrationError).httpStatus).toBe(303);
  });
});

describe("registerSignedStatement", () => {
  it("POSTs the COSE Sign1 body to /entries with the grant header", async () => {
    const captured: Captured[] = [];
    const res = new Response(null, {
      status: 303,
      headers: { Location: "/status" },
    });
    const statement = new Uint8Array([0x84, 1, 2, 3]);
    const { statusUrl } = await registerSignedStatement({
      baseUrl: BASE,
      bootstrapLogId: BOOTSTRAP,
      grantBase64: GRANT_B64,
      statement,
      fetchImpl: mockFetch(res, captured),
    });
    expect(statusUrl).toBe(`${BASE}/status`);
    expect(captured[0]!.url).toBe(`${BASE}/register/${BOOTSTRAP}/entries`);
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe(COSE_SIGN1_CONTENT_TYPE);
    expect(captured[0]!.init.body).toEqual(statement);
  });
});
