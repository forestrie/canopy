import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "cbor-x";
import { describe, expect, it } from "vitest";
import { hexToBytes } from "./hex-test.js";
import { verifyCoseSign1 } from "./verify-cose-sign1.js";

const dir = dirname(fileURLToPath(import.meta.url));

interface GoldensFile {
  sigStructureVectors: Array<{
    name: string;
    protectedMapInnerHex: string;
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

describe("verifyCoseSign1 + go-cose Sig_structure bytes", () => {
  it("verifies ES256 over golden ToBeSigned (kid-only protected)", async () => {
    const gold = loadGoldens();
    const v = gold.sigStructureVectors.find(
      (x) => x.name === "protected_kid_only_empty_aad",
    )!;
    const protectedInner = hexToBytes(v.protectedMapInnerHex);
    const payload = hexToBytes(v.payloadHex);
    const sigStructure = hexToBytes(v.sigStructureHex);

    const pair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;

    const sigBuf = (await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      sigStructure.buffer.slice(
        sigStructure.byteOffset,
        sigStructure.byteOffset + sigStructure.byteLength,
      ) as ArrayBuffer,
    )) as ArrayBuffer;
    const sig64 = new Uint8Array(sigBuf);
    expect(sig64.byteLength).toBe(64);

    const sign1Bytes = new Uint8Array(
      encode([protectedInner, new Map<number, Uint8Array>(), payload, sig64]),
    );

    await expect(verifyCoseSign1(sign1Bytes, pair.publicKey)).resolves.toBe(
      true,
    );
  });

  it("verifies ES256 when Sign1 payload is null (detached content)", async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;

    const protectedInner = new Uint8Array(
      encode(new Map<number, number>([[1, -7]])),
    );
    const { encodeSigStructure } = await import("./encode-sig-structure.js");
    const sigStructure = encodeSigStructure(
      protectedInner,
      new Uint8Array(0),
      new Uint8Array(0),
    );

    const sigBuf = (await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      sigStructure.buffer.slice(
        sigStructure.byteOffset,
        sigStructure.byteOffset + sigStructure.byteLength,
      ) as ArrayBuffer,
    )) as ArrayBuffer;
    const sig64 = new Uint8Array(sigBuf);
    expect(sig64.byteLength).toBe(64);

    const sign1Bytes = new Uint8Array(
      encode([protectedInner, new Map<number, unknown>(), null, sig64]),
    );

    await expect(verifyCoseSign1(sign1Bytes, pair.publicKey)).resolves.toBe(
      true,
    );
  });
});
