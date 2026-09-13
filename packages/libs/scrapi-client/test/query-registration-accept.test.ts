import { describe, expect, it } from "vitest";

import { queryRegistrationRaw } from "../src/index.js";

const STATUS_URL = "https://logs.example.test/logs/aa/bb/entries/cc";

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

describe("queryRegistrationRaw", () => {
  it("keeps defaulting Accept to application/cbor (unaffected by FOR-559)", async () => {
    const captured: Captured[] = [];
    const res = new Response(null, {
      status: 303,
      headers: { Location: "/status" },
    });
    await queryRegistrationRaw({
      statusUrl: STATUS_URL,
      fetchImpl: mockFetch(res, captured),
    });
    expect(
      (captured[0]!.init.headers as Record<string, string>)["Accept"],
    ).toBe("application/cbor");
  });

  it("honours an explicit accept option override", async () => {
    const captured: Captured[] = [];
    const res = new Response(null, {
      status: 303,
      headers: { Location: "/status" },
    });
    await queryRegistrationRaw({
      statusUrl: STATUS_URL,
      accept: "application/cose",
      fetchImpl: mockFetch(res, captured),
    });
    expect(
      (captured[0]!.init.headers as Record<string, string>)["Accept"],
    ).toBe("application/cose");
  });
});
