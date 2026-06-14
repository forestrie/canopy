/**
 * Go delegationcert-compatible checks for delegation certificate payload field 5.
 * Mirrors arbor `DelegatedKeyFromCertificate` / `normalizeAnyIntKeyedMap`.
 */

import { decode } from "cbor-x";

const PAYLOAD_DELEGATED_KEY = 5;
const COSE_KTY = 1;
const COSE_CRV = -1;
const COSE_X = -2;
const COSE_Y = -3;
const COSE_KTY_EC2 = 2;
const COSE_CRV_P256 = 1;

function bytesFromUnknown(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`${label} is not bytes`);
}

function normalizeIntKeyedMap(raw: unknown): Map<number, unknown> {
  if (raw instanceof Map) {
    return new Map(
      [...raw.entries()].map(([key, value]) => {
        const numericKey = Number(key);
        if (!Number.isInteger(numericKey)) {
          throw new Error(`map key ${String(key)} is not an integer`);
        }
        return [numericKey, value];
      }),
    );
  }
  if (raw && typeof raw === "object" && !(raw instanceof Uint8Array)) {
    const out = new Map<number, unknown>();
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const numericKey = Number(key);
      if (!Number.isInteger(numericKey)) {
        throw new Error(`map key ${key} is not an integer`);
      }
      out.set(numericKey, value);
    }
    return out;
  }
  throw new Error("delegated COSE_Key is not a map");
}

function parseDelegatedCoseKeyFromPayload(raw: unknown): void {
  if (raw instanceof Uint8Array) {
    throw new Error(
      "payload field 5 must be inline integer-key COSE_Key map, not bstr",
    );
  }
  const m = normalizeIntKeyedMap(raw);
  const kty = Number(m.get(COSE_KTY));
  if (kty !== COSE_KTY_EC2) {
    throw new Error("delegated public key: expected kty EC2");
  }
  const crv = Number(m.get(COSE_CRV));
  if (crv !== COSE_CRV_P256) {
    throw new Error("delegated public key: unsupported crv");
  }
  const x = bytesFromUnknown(m.get(COSE_X), "delegated key x");
  const y = bytesFromUnknown(m.get(COSE_Y), "delegated key y");
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("delegated public key: x and y must be 32 bytes");
  }
}

/** Assert certificate payload field 5 matches Go sealer parse rules. */
export function assertGoCompatibleDelegatedKeyInCertificate(
  certificate: Uint8Array,
): void {
  const cert = decode(certificate) as unknown[];
  if (!Array.isArray(cert) || cert.length !== 4) {
    throw new Error("delegation certificate must be COSE_Sign1 array");
  }
  const payloadBytes = bytesFromUnknown(cert[2], "payload");
  const payloadMap = normalizeIntKeyedMap(decode(payloadBytes));
  parseDelegatedCoseKeyFromPayload(payloadMap.get(PAYLOAD_DELEGATED_KEY));
}

export {
  PAYLOAD_DELEGATED_KEY,
  normalizeIntKeyedMap,
  parseDelegatedCoseKeyFromPayload,
};
