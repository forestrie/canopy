/**
 * Grant format unit tests (Plan 0001 Step 1; Forestrie-Grant wire **v0**: keys 1–6 / 0–6).
 */

import { encode as encodeCbor } from "cbor-x";
import { describe, expect, it } from "vitest";
import {
  decodeGrantPayload,
  decodeGrantResponse,
  encodeGrantForResponse,
} from "../src/grant/codec.js";
import { grantDataToBytes, type Grant } from "../src/grant/types.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";
import grantVectors from "./fixtures/grant_vectors.json";

const DEFAULT_IDTIMESTAMP = new Uint8Array(8).fill(1);

function minimalGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    logId: uuidToBytes("550e8400-e29b-41d4-a716-446655440000"),
    ownerLogId: uuidToBytes("660e8400-e29b-41d4-a716-446655440001"),
    grant: (() => {
      const f = new Uint8Array(8);
      f[7] = 1;
      return f;
    })(),
    grantData: new Uint8Array([0xab, 0xcd]),
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
    const idtimestamp = DEFAULT_IDTIMESTAMP;
    const bytes = encodeGrantForResponse(grant, idtimestamp);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    const { grant: decoded, idtimestamp: decodedIdts } =
      decodeGrantResponse(bytes);
    expect(decoded.logId.length).toBe(32);
    expect(decoded.ownerLogId.length).toBe(32);
    expect(decoded.grant.length).toBe(8);
    expect(new Uint8Array(decodedIdts)).toEqual(new Uint8Array(idtimestamp));
    expect(decoded.maxHeight).toBe(0);
    expect(decoded.minGrowth).toBe(0);
    expect(grantDataToBytes(decoded.grantData)).toEqual(
      grantDataToBytes(grant.grantData),
    );
  });

  it("same grant produces same bytes (deterministic)", () => {
    const grant = minimalGrant();
    const idtimestamp = DEFAULT_IDTIMESTAMP;
    const a = encodeGrantForResponse(grant, idtimestamp);
    const b = encodeGrantForResponse(grant, idtimestamp);
    expect(a).toEqual(b);
  });

  it("optional maxHeight/minGrowth round-trip", () => {
    const grant = minimalGrant({
      maxHeight: 100,
      minGrowth: 10,
    });
    const bytes = encodeGrantForResponse(grant, DEFAULT_IDTIMESTAMP);
    const { grant: decoded } = decodeGrantResponse(bytes);
    expect(decoded.maxHeight).toBe(100);
    expect(decoded.minGrowth).toBe(10);
  });
});

describe("Grant format (decode validation)", () => {
  it("rejects empty payload", () => {
    expect(() => decodeGrantPayload(new Uint8Array(0))).toThrow("empty");
  });

  it("rejects truncated/invalid CBOR", () => {
    expect(() => decodeGrantPayload(new Uint8Array([0xa0]))).toThrow();
    expect(() => decodeGrantPayload(new Uint8Array([0x01, 0x02]))).toThrow();
  });

  it("rejects non-map payload", () => {
    const array = new Uint8Array([0x81, 0x01]);
    expect(() => decodeGrantPayload(array)).toThrow("must be a CBOR map");
  });

  it("rejects obsolete CBOR keys 7 and 8", () => {
    const log = new Uint8Array(32);
    const flags = new Uint8Array(8);
    const m = new Map<number, unknown>([
      [1, log],
      [2, log],
      [3, flags],
      [4, 0],
      [5, 0],
      [6, new Uint8Array(0)],
      [7, new Uint8Array([1])],
    ]);
    const bad = new Uint8Array(encodeCbor(m));
    expect(() => decodeGrantPayload(bad)).toThrow("obsolete CBOR keys");
  });

  it("rejects truncated CBOR", () => {
    const golden = hexToBytes(
      (grantVectors as { expected_cbor_hex: string }[])[0]!.expected_cbor_hex,
    );
    expect(() =>
      decodeGrantResponse(golden.subarray(0, golden.length - 4)),
    ).toThrow();
  });
});

describe("Grant format (known-answer from grant_vectors.json)", () => {
  for (const [, v] of (
    grantVectors as Array<{ description: string; expected_cbor_hex: string }>
  ).entries()) {
    it(v.description, () => {
      const cborBytes = hexToBytes(v.expected_cbor_hex);
      const { grant, idtimestamp } = decodeGrantResponse(cborBytes);
      const reencoded = encodeGrantForResponse(grant, idtimestamp);
      expect(Array.from(reencoded)).toEqual(Array.from(cborBytes));
    });
  }
});
