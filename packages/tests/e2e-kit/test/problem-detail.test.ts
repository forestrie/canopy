import { encodeCborDeterministic } from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
import { problemDetailFromBytes } from "../src/problem-detail.js";

const problem = {
  type: "about:blank",
  title: "Bad Request",
  status: 400,
  detail: "Invalid CBOR body",
};

describe("problemDetailFromBytes (FOR-579)", () => {
  it("decodes CBOR problem details regardless of the +problem suffix", () => {
    const bytes = encodeCborDeterministic(problem);
    expect(problemDetailFromBytes(bytes, "application/cbor")).toBe(
      "Bad Request: Invalid CBOR body",
    );
    expect(problemDetailFromBytes(bytes, "application/problem+cbor")).toBe(
      "Bad Request: Invalid CBOR body",
    );
  });
  it("decodes JSON problem details and falls back to text", () => {
    const enc = new TextEncoder();
    expect(
      problemDetailFromBytes(
        enc.encode(JSON.stringify({ title: "Unauthorized", status: 401 })),
        "application/problem+json",
      ),
    ).toBe("Unauthorized");
    expect(problemDetailFromBytes(enc.encode("Not Found"), "text/plain")).toBe(
      "Not Found",
    );
    expect(
      problemDetailFromBytes(new Uint8Array([0xff, 0xff]), "application/cbor"),
    ).toEqual(expect.any(String));
    expect(problemDetailFromBytes(new Uint8Array(), "application/cbor")).toBe(
      "",
    );
  });
});
