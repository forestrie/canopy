/**
 * Grant format unit tests (Plan 0001 Step 1; Plan 0004 subplan 01 wire format).
 * Wire format: go-univocity keys 0–8, fixed 32/32/8 for logId/ownerLogId/grantFlags.
 */

import { describe, expect, it } from "vitest";
import { decodeGrant, encodeGrant } from "../src/grant/codec.js";
import { KIND_ATTESTOR } from "../src/grant/kinds.js";
import { GRANT_VERSION, type Grant } from "../src/grant/types.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";
import grantVectors from "./fixtures/grant_vectors.json";

function minimalGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    version: GRANT_VERSION,
    idtimestamp: new Uint8Array(8).fill(1),
    logId: uuidToBytes("550e8400-e29b-41d4-a716-446655440000"),
    ownerLogId: uuidToBytes("660e8400-e29b-41d4-a716-446655440001"),
    grantFlags: (() => {
      const f = new Uint8Array(8);
      f[7] = 1;
      return f;
    })(),
    grantData: new Uint8Array([0xab, 0xcd]),
    signer: new Uint8Array([0x01, 0x02]),
    kind: new Uint8Array([KIND_ATTESTOR]),
    ...overrides,
  };
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/\s/g, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

describe("Grant format (encode/decode)", () => {
  it("round-trips encode and decode", () => {
    const grant = minimalGrant();
    const bytes = encodeGrant(grant);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    const decoded = decodeGrant(bytes);
    expect(decoded.version).toBe(grant.version);
    expect(decoded.logId.length).toBe(32);
    expect(decoded.ownerLogId.length).toBe(32);
    expect(decoded.grantFlags.length).toBe(8);
    expect(new Uint8Array(decoded.idtimestamp)).toEqual(
      new Uint8Array(grant.idtimestamp),
    );
    expect(decoded.maxHeight).toBe(0);
    expect(decoded.minGrowth).toBe(0);
    expect(new Uint8Array(decoded.grantData)).toEqual(
      new Uint8Array(grant.grantData),
    );
    expect(new Uint8Array(decoded.signer)).toEqual(
      new Uint8Array(grant.signer),
    );
    expect(new Uint8Array(decoded.kind)).toEqual(new Uint8Array(grant.kind));
  });

  it("same grant produces same bytes (deterministic)", () => {
    const grant = minimalGrant();
    const a = encodeGrant(grant);
    const b = encodeGrant(grant);
    expect(a).toEqual(b);
  });

  it("optional maxHeight/minGrowth round-trip", () => {
    const grant = minimalGrant({
      maxHeight: 100,
      minGrowth: 10,
    });
    const bytes = encodeGrant(grant);
    const decoded = decodeGrant(bytes);
    expect(decoded.maxHeight).toBe(100);
    expect(decoded.minGrowth).toBe(10);
  });
});

describe("Grant format (decode validation)", () => {
  it("rejects empty payload", () => {
    expect(() => decodeGrant(new Uint8Array(0))).toThrow("empty");
  });

  it("rejects truncated/invalid CBOR", () => {
    expect(() => decodeGrant(new Uint8Array([0xa0]))).toThrow();
    expect(() => decodeGrant(new Uint8Array([0x01, 0x02]))).toThrow();
  });

  it("rejects non-map payload", () => {
    const array = new Uint8Array([0x81, 0x01]);
    expect(() => decodeGrant(array)).toThrow("must be a CBOR map");
  });

  it("rejects truncated CBOR", () => {
    const golden = hexToBytes(
      (grantVectors as { expected_cbor_hex: string }[])[0]!.expected_cbor_hex,
    );
    expect(() => decodeGrant(golden.subarray(0, golden.length - 4))).toThrow();
  });

  it("decoded grant has non-empty signer from minimal vector", () => {
    const minimalCbor = hexToBytes(
      (grantVectors as { expected_cbor_hex: string }[])[1]!.expected_cbor_hex,
    );
    const decoded = decodeGrant(minimalCbor);
    expect(decoded.signer.length).toBeGreaterThan(0);
  });
});

describe("Grant format (known-answer from grant_vectors.json)", () => {
  for (const [i, v] of (
    grantVectors as Array<{ description: string; expected_cbor_hex: string }>
  ).entries()) {
    it(v.description, () => {
      const cborBytes = hexToBytes(v.expected_cbor_hex);
      const decoded = decodeGrant(cborBytes);
      const reencoded = encodeGrant(decoded);
      expect(Array.from(reencoded)).toEqual(Array.from(cborBytes));
    });
  }
});
