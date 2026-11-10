/**
 * The shared KS256 low-s vector. Source of truth: forestrie/protocol
 * vectors/fixtures/ks256-low-s.json (cases in vectors/README.md, "KS256
 * low-s"); canopy keeps one byte-identical copy in
 * packages/shared/encoding/src/testdata/, pinned by SHA-256 below, which
 * canopy-api's verifier test reads too. Do not edit the copy; change
 * protocol and re-copy.
 *
 * A recovered KS256 signature must be low-s (s <= (n-1)/2): each reject case
 * is the high-s twin of an accept case and recovers the same address, so only
 * the s bound refuses it.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Ks256VerifyHooks } from "../src/index.js";
import { verifyDelegationCertificateKs256 } from "../src/index.js";

const VECTOR_SHA256 =
  "3a325aaa1bb296316f3f4ef8e2d8a8ae4c1728c00fc283f3cdd2438a2c9d88dc";

interface Ks256LowSCase {
  name: string;
  twin_of?: string;
  signer_address_hex: string;
  signature_hex: string;
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
  digest_hex: string;
  cases: Ks256LowSCase[];
};

const hex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

describe("KS256 low-s vector: verifyDelegationCertificateKs256", () => {
  it("reads the pinned copy of the protocol vector", () => {
    expect(createHash("sha256").update(vectorBytes).digest("hex")).toBe(
      VECTOR_SHA256,
    );
  });

  it.each(vector.cases.map((c) => [c.name, c] as const))(
    "%s",
    async (_name, c) => {
      const ok = await verifyDelegationCertificateKs256(
        hex(c.cose_sign1_hex),
        hex(c.signer_address_hex),
      );
      expect(ok).toBe(c.expect.result === "accept");
    },
  );

  it("hands a contract root the high-s signature unchanged (ERC-1271)", async () => {
    const highS = vector.cases.find((c) => c.name === "reject/high-s")!;
    const seen: { hash?: string; signature?: string } = {};
    const hooks: Ks256VerifyHooks = {
      hasContractCode: async () => true,
      isValidSignature: async (_address, hash, signature) => {
        seen.hash = Buffer.from(hash).toString("hex");
        seen.signature = Buffer.from(signature).toString("hex");
        return true;
      },
    };
    const ok = await verifyDelegationCertificateKs256(
      hex(highS.cose_sign1_hex),
      hex(highS.signer_address_hex),
      hooks,
    );
    expect(ok).toBe(true);
    expect(seen).toEqual({
      hash: vector.digest_hex,
      signature: highS.signature_hex,
    });
  });
});
