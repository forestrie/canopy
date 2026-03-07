/**
 * Grant format unit tests (Plan 0001 Step 1 verification).
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { describe, expect, it } from "vitest";
import { decodeGrant, encodeGrant } from "../src/grant/codec.js";
import { KIND_ATTESTOR } from "../src/grant/kinds.js";
import { GRANT_VERSION, type Grant } from "../src/grant/types.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";

function minimalGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    version: GRANT_VERSION,
    idtimestamp: new Uint8Array(8).fill(1),
    logId: uuidToBytes("550e8400-e29b-41d4-a716-446655440000"),
    ownerLogId: uuidToBytes("660e8400-e29b-41d4-a716-446655440001"),
    grantFlags: (() => {
      const f = new Uint8Array(8);
      f[0] = 1;
      return f;
    })(),
    grantData: new Uint8Array([0xab, 0xcd]),
    signer: new Uint8Array([0x01, 0x02]),
    kind: new Uint8Array([KIND_ATTESTOR]),
    ...overrides,
  };
}

describe("Grant format (encode/decode)", () => {
  it("round-trips encode and decode", () => {
    const grant = minimalGrant();
    const bytes = encodeGrant(grant);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    const decoded = decodeGrant(bytes);
    expect(decoded.version).toBe(grant.version);
    expect(new Uint8Array(decoded.logId)).toEqual(new Uint8Array(grant.logId));
    expect(new Uint8Array(decoded.ownerLogId)).toEqual(new Uint8Array(grant.ownerLogId));
    expect(new Uint8Array(decoded.grantFlags)).toEqual(new Uint8Array(grant.grantFlags));
    expect(new Uint8Array(decoded.kind)).toEqual(new Uint8Array(grant.kind));
    expect(new Uint8Array(decoded.idtimestamp)).toEqual(new Uint8Array(grant.idtimestamp));
    expect(new Uint8Array(decoded.grantData)).toEqual(new Uint8Array(grant.grantData));
    expect(new Uint8Array(decoded.signer)).toEqual(new Uint8Array(grant.signer));
  });

  it("same grant produces same bytes (deterministic)", () => {
    const grant = minimalGrant();
    const a = encodeGrant(grant);
    const b = encodeGrant(grant);
    expect(a).toEqual(b);
  });

  it("optional fields round-trip", () => {
    const grant = minimalGrant({
      maxHeight: 100,
      minGrowth: 10,
      exp: 2000000000,
      nbf: 1000000000,
    });
    const bytes = encodeGrant(grant);
    const decoded = decodeGrant(bytes);
    expect(decoded.maxHeight).toBe(100);
    expect(decoded.minGrowth).toBe(10);
    expect(decoded.exp).toBe(2000000000);
    expect(decoded.nbf).toBe(1000000000);
  });
});

describe("Grant format (decode validation)", () => {
  it("rejects empty payload", () => {
    expect(() => decodeGrant(new Uint8Array(0))).toThrow("empty");
  });

  it("rejects truncated/invalid CBOR", () => {
    expect(() => decodeGrant(new Uint8Array([0xa0]))).toThrow(); // empty map
    expect(() => decodeGrant(new Uint8Array([0x01, 0x02]))).toThrow();
  });

  it("rejects non-map payload", () => {
    const array = new Uint8Array([0x81, 0x01]); // [1]
    expect(() => decodeGrant(array)).toThrow("must be a CBOR map");
  });

  it("rejects missing version", () => {
    const grant = minimalGrant();
    const bytes = encodeGrant(grant);
    const raw = decodeCbor(bytes) as Record<number, unknown>;
    delete raw[1];
    const bad = encodeCbor(raw);
    expect(() => decodeGrant(bad)).toThrow("missing required field: version");
  });

  it("rejects unknown version", () => {
    const grant = minimalGrant({ version: 99 });
    const bytes = encodeGrant(grant);
    expect(() => decodeGrant(bytes)).toThrow("unknown version: 99");
  });

  it("rejects missing required field: logId", () => {
    const grant = minimalGrant();
    const bytes = encodeGrant(grant);
    const raw = decodeCbor(bytes) as Record<number, unknown>;
    delete raw[3]; // logId
    expect(() => decodeGrant(encodeCbor(raw))).toThrow("logId");
  });

  it("rejects missing required field: signer", () => {
    const grant = minimalGrant();
    const bytes = encodeGrant(grant);
    const raw = decodeCbor(bytes) as Record<number, unknown>;
    delete raw[9]; // signer
    expect(() => decodeGrant(encodeCbor(raw))).toThrow("missing required field: signer");
  });
});
