import { encodeCborDeterministic } from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
import { decodeProblemDetailsBytes } from "../src/index.js";

/**
 * plan-2609-07 decision L2: problem-details decoding gates on
 * `application/problem+cbor` when the content type is known, so a CBOR body
 * under an unrelated content type (e.g. a receipt) is never misread as
 * problem details just because it happens to decode as a map.
 */
describe("decodeProblemDetailsBytes", () => {
  const problem = { title: "boom", status: 500, detail: "synthetic" };
  const bytes = encodeCborDeterministic(problem);

  it("decodes when contentType is application/problem+cbor", () => {
    const out = decodeProblemDetailsBytes(bytes, "application/problem+cbor");
    expect(out).toEqual(problem);
  });

  it("decodes opportunistically when contentType is omitted", () => {
    const out = decodeProblemDetailsBytes(bytes);
    expect(out).toEqual(problem);
  });

  it("skips decoding when contentType is a different media type", () => {
    const out = decodeProblemDetailsBytes(
      bytes,
      "application/scitt-receipt+cbor",
    );
    expect(out).toBeUndefined();
  });

  it("returns undefined for an empty body", () => {
    expect(
      decodeProblemDetailsBytes(new Uint8Array(0), "application/problem+cbor"),
    ).toBeUndefined();
    expect(
      decodeProblemDetailsBytes(undefined, "application/problem+cbor"),
    ).toBeUndefined();
  });

  it("returns undefined for non-CBOR-map bytes even under the right content type", () => {
    const notAMap = new Uint8Array([0x01, 0x02, 0x03]);
    expect(
      decodeProblemDetailsBytes(notAMap, "application/problem+cbor"),
    ).toBeUndefined();
  });
});
