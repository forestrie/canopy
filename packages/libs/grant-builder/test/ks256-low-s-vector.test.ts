/**
 * The shared KS256 low-s vector against grant-builder's
 * {@link verifyKs256GrantStatement}. Source of truth: forestrie/protocol
 * vectors/fixtures/ks256-low-s.json; canopy's one copy is
 * packages/shared/encoding/src/testdata/, pinned by SHA-256 below. Do not
 * edit the copy; change protocol and re-copy.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyKs256GrantStatement } from "../src/ks256-wallet-grant.js";

const VECTOR_SHA256 =
  "3a325aaa1bb296316f3f4ef8e2d8a8ae4c1728c00fc283f3cdd2438a2c9d88dc";

interface Ks256LowSCase {
  name: string;
  signer_address_hex: string;
  cose_sign1_hex: string;
  expect: { result: "accept" } | { result: "reject"; reason: string };
}

const vectorBytes = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../shared/encoding/src/testdata/ks256-low-s.json",
  ),
);
const vector = JSON.parse(vectorBytes.toString("utf8")) as {
  cases: Ks256LowSCase[];
};

const hex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

describe("KS256 low-s vector: verifyKs256GrantStatement", () => {
  it("reads the pinned copy of the protocol vector", () => {
    expect(createHash("sha256").update(vectorBytes).digest("hex")).toBe(
      VECTOR_SHA256,
    );
  });

  it.each(vector.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(
      verifyKs256GrantStatement(
        hex(c.cose_sign1_hex),
        hex(c.signer_address_hex),
      ),
    ).toBe(c.expect.result === "accept");
  });
});
