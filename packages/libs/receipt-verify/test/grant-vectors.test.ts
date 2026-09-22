/**
 * Grant wire vectors (protocol#4, FOR-580): the grant codec's keys 0–6
 * decode round-trip, and — the regression this suite exists for — every
 * negative vector carrying the retired keys 7 (`signer`) / 8 (`kind`) is
 * rejected. Before FOR-580, {@link decodeGrantPayload} and
 * {@link decodeGrantResponse} read fields by key number and silently
 * ignored keys 7/8, unlike the admission-path codecs
 * (`packages/shared/encoding/src/grant-codec.ts`,
 * `packages/apps/canopy-api/src/grant/codec.ts`).
 *
 * Vector files: read via a relative path from canopy-api's vendored copy
 * (packages/apps/canopy-api/test/fixtures/grant_vectors{,_negative}.json) —
 * the single copy this repo keeps, vendored from
 * https://github.com/forestrie/protocol `vectors/fixtures/`. See
 * ../../apps/canopy-api/test/fixtures/SOURCE.md for the pinned SHA-256s and
 * provenance. Do not edit the vectors, only this test.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeGrantPayload, decodeGrantResponse } from "../src/grant-codec.js";

const dir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(
  dir,
  "..",
  "..",
  "..",
  "apps",
  "canopy-api",
  "test",
  "fixtures",
);

/** Pinned per fixtures/SOURCE.md. */
const EXPECTED_SHA256_POSITIVE =
  "03ef03ebc39e5582041f87d4457b99faec54e1851274f9429c198b741908cdb8";
const EXPECTED_SHA256_NEGATIVE =
  "f5d388ca020c67d73c70318b65be2e1f901342edbad867b1147765e624621996";

interface PositiveVector {
  description: string;
  expected_cbor_hex: string;
}

interface NegativeVector {
  description: string;
  cbor_hex: string;
  must_reject: true;
  reason: string;
  obsolete_keys: number[];
}

function loadJson<T>(name: string): { raw: string; data: T } {
  const raw = readFileSync(join(fixturesDir, name), "utf8");
  return { raw, data: JSON.parse(raw) as T };
}

const fromHex = (hex: string): Uint8Array =>
  new Uint8Array(Buffer.from(hex, "hex"));

const positive = loadJson<PositiveVector[]>("grant_vectors.json");
const negative = loadJson<NegativeVector[]>("grant_vectors_negative.json");

describe("grant vectors (protocol#4) — vendored copy pins", () => {
  it("grant_vectors.json matches the pinned SHA-256", () => {
    expect(createHash("sha256").update(positive.raw).digest("hex")).toBe(
      EXPECTED_SHA256_POSITIVE,
    );
  });

  it("grant_vectors_negative.json matches the pinned SHA-256", () => {
    expect(createHash("sha256").update(negative.raw).digest("hex")).toBe(
      EXPECTED_SHA256_NEGATIVE,
    );
  });
});

describe("decodeGrantResponse vs grant_vectors.json (positive)", () => {
  expect(positive.data.length).toBeGreaterThan(0);
  for (const v of positive.data) {
    it(v.description, () => {
      const cborBytes = fromHex(v.expected_cbor_hex);
      expect(() => decodeGrantResponse(cborBytes)).not.toThrow();
    });
  }
});

describe("decodeGrantPayload / decodeGrantResponse vs grant_vectors_negative.json", () => {
  expect(negative.data.length).toBeGreaterThan(0);
  for (const v of negative.data) {
    it(`${v.description} — decodeGrantResponse rejects`, () => {
      const cborBytes = fromHex(v.cbor_hex);
      expect(() => decodeGrantResponse(cborBytes)).toThrow(
        "obsolete CBOR keys 7 (signer) and 8 (kind)",
      );
    });

    it(`${v.description} — decodeGrantPayload rejects`, () => {
      const cborBytes = fromHex(v.cbor_hex);
      expect(() => decodeGrantPayload(cborBytes)).toThrow(
        "obsolete CBOR keys 7 (signer) and 8 (kind)",
      );
    });
  }
});
