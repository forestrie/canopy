import { describe, expect, it } from "vitest";
import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";
import {
  bytesToUuid,
  decodeGrantPayload,
  decodeGrantResponse,
  encodeGrantForResponse,
  encodeGrantPayload,
  encodeGrantPayloadV0Canonical,
  uuidToBytes,
  type Grant,
} from "./index.js";

const LOG_ID = "0198c1a2-3b4c-7d5e-8f60-718293a4b5c6";
const OWNER_ID = "0198c1a2-3b4c-7d5e-8f60-718293a4b5c7";

/**
 * GF_DATA_LOG | GF_CREATE | GF_EXTEND 8-byte wire flags. Mirrors
 * grant-builder's `dataLogCreateExtendFlags` — semantic flag constructors
 * stay in @forestrie/grant-builder; only the wire codec lives here.
 */
function dataLogCreateExtendFlags(): Uint8Array {
  const grant = new Uint8Array(8);
  grant[3] = 0x03;
  grant[7] = 0x02;
  return grant;
}

function testGrant(): Grant {
  return {
    logId: uuidToBytes(LOG_ID),
    ownerLogId: uuidToBytes(OWNER_ID),
    grant: dataLogCreateExtendFlags(),
    maxHeight: 14,
    minGrowth: 2,
    grantData: new Uint8Array(64).fill(7),
  };
}

describe("grant payload codec (keys 1-6)", () => {
  it("round-trips encodeGrantPayload -> decodeGrantPayload", () => {
    const grant = testGrant();
    const decoded = decodeGrantPayload(encodeGrantPayload(grant));
    expect(bytesToUuid(decoded.logId)).toBe(LOG_ID);
    expect(bytesToUuid(decoded.ownerLogId)).toBe(OWNER_ID);
    expect(decoded.grant).toEqual(dataLogCreateExtendFlags());
    expect(decoded.maxHeight).toBe(14);
    expect(decoded.minGrowth).toBe(2);
    expect(decoded.grantData).toEqual(new Uint8Array(64).fill(7));
  });

  it("canonical payload decodes identically to cbor-x payload", () => {
    const grant = testGrant();
    const canonical = decodeGrantPayload(encodeGrantPayloadV0Canonical(grant));
    const tagged = decodeGrantPayload(encodeGrantPayload(grant));
    expect(canonical).toEqual(tagged);
  });

  it("rejects obsolete wire keys 7 (signer) and 8 (kind)", () => {
    const bytes = new Uint8Array(
      encodeCborDeterministic(new Map<number, unknown>([[7, new Uint8Array(20)]])),
    );
    expect(() => decodeGrantPayload(bytes)).toThrow(/obsolete CBOR keys/);
  });
});

describe("grant response codec (keys 0-6)", () => {
  it("round-trips encodeGrantForResponse -> decodeGrantResponse", () => {
    const grant = testGrant();
    const idts = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const { grant: decoded, idtimestamp } = decodeGrantResponse(
      encodeGrantForResponse(grant, idts),
    );
    expect(idtimestamp).toEqual(idts);
    expect(bytesToUuid(decoded.logId)).toBe(LOG_ID);
    expect(decoded.grantData).toEqual(new Uint8Array(64).fill(7));
  });
});
