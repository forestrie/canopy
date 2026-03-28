import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeCborBstr } from "./encode-cbor-bstr.js";
import { hexToBytes } from "./hex-test.js";

const dir = dirname(fileURLToPath(import.meta.url));

interface GoldensFile {
  bstrVectors: Array<{
    name: string;
    payloadHex: string;
    encodingHex: string;
  }>;
}

function loadGoldens(): GoldensFile {
  const raw = readFileSync(
    join(dir, "testdata", "go-cose-goldens.json"),
    "utf8",
  );
  return JSON.parse(raw) as GoldensFile;
}

describe("encodeCborBstr (fxamacker / go-cose canonical bstr)", () => {
  const gold = loadGoldens();

  it.each(gold.bstrVectors)("matches go-cose golden %#", (v) => {
    const payload = hexToBytes(v.payloadHex);
    const got = encodeCborBstr(payload);
    expect(Buffer.from(got).toString("hex")).toBe(v.encodingHex);
  });
});
