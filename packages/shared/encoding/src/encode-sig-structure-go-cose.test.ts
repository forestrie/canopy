import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeSigStructure } from "./encode-sig-structure.js";
import { hexToBytes } from "./hex-test.js";

const dir = dirname(fileURLToPath(import.meta.url));

interface GoldensFile {
  goCoseVersion: string;
  sigStructureVectors: Array<{
    name: string;
    protectedMapInnerHex: string;
    externalAadHex: string;
    payloadHex: string;
    sigStructureHex: string;
  }>;
}

function loadGoldens(): GoldensFile {
  const raw = readFileSync(
    join(dir, "testdata", "go-cose-goldens.json"),
    "utf8",
  );
  return JSON.parse(raw) as GoldensFile;
}

describe("encodeSigStructure vs veraison/go-cose Sign1Message.toBeSigned", () => {
  const gold = loadGoldens();

  it("documents generator dependency", () => {
    expect(gold.goCoseVersion).toMatch(/^v1\.3\./);
  });

  it.each(gold.sigStructureVectors)("golden %#", (v) => {
    const protectedMap = hexToBytes(v.protectedMapInnerHex);
    const ext = hexToBytes(v.externalAadHex);
    const payload = hexToBytes(v.payloadHex);
    const got = encodeSigStructure(protectedMap, ext, payload);
    expect(Buffer.from(got).toString("hex")).toBe(v.sigStructureHex);
  });
});

describe("encodeSig_structure shape (RFC 8152 §4.4)", () => {
  it("starts with CBOR array(4), Signature1 tstr, then body_protected bstr", () => {
    const gold = loadGoldens();
    const v = gold.sigStructureVectors.find(
      (x) => x.name === "custodian_profile_es256_empty_aad",
    )!;
    const bytes = hexToBytes(v.sigStructureHex);
    expect(bytes[0]).toBe(0x84);
    expect(bytes[1]).toBe(0x60 + "Signature1".length);
    const tlen = "Signature1".length;
    const ctx = new TextDecoder().decode(bytes.slice(2, 2 + tlen));
    expect(ctx).toBe("Signature1");
    const bodyProtectedHead = bytes[2 + tlen];
    expect(bodyProtectedHead >> 5).toBe(2);
  });
});
