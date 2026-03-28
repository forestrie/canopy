import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeCoseProtectedMapBytes } from "./encode-cose-protected.js";
import { hexToBytes } from "./hex-test.js";

const dir = dirname(fileURLToPath(import.meta.url));

interface GoldensFile {
  sigStructureVectors: Array<{
    name: string;
    protectedMapInnerHex: string;
  }>;
}

function loadGoldens(): GoldensFile {
  const raw = readFileSync(
    join(dir, "testdata", "go-cose-goldens.json"),
    "utf8",
  );
  return JSON.parse(raw) as GoldensFile;
}

describe("encodeCoseProtectedMapBytes vs go-cose protected map", () => {
  it("kid-only header matches go-cose canonical map bytes", () => {
    const gold = loadGoldens();
    const v = gold.sigStructureVectors.find(
      (x) => x.name === "protected_kid_only_empty_aad",
    )!;
    const kid = new Uint8Array(16);
    for (let i = 0; i < 16; i++) kid[i] = i + 1;
    const got = encodeCoseProtectedMapBytes(kid);
    expect(Buffer.from(got).toString("hex")).toBe(v.protectedMapInnerHex);
  });
});
