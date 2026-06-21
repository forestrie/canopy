import { decode } from "cbor-x";
import { bytesFromUnknown } from "./bytes-utils.js";
import {
  COSE_CRV,
  COSE_CRV_P256,
  COSE_KTY,
  COSE_KTY_EC2,
  COSE_X,
  COSE_Y,
  PAYLOAD_DELEGATED_KEY,
} from "./payload-labels.js";
import type { ParsedDelegatedKey } from "./parsed-delegated-key.js";

export function normalizeIntKeyedMap(raw: unknown): Map<number, unknown> {
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

/** Parse inline payload field 5 (integer-key COSE_Key map). */
export function parseDelegatedCoseKeyFromPayload(
  raw: unknown,
): ParsedDelegatedKey {
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
  return { x, y };
}

/** Decode CBOR COSE_Key bytes to an inline integer-key map for payload field 5. */
export function decodeDelegatedCoseKeyFromBytes(
  bytes: Uint8Array,
): Map<number, unknown> {
  const raw = decode(bytes) as unknown;
  return normalizeIntKeyedMap(raw);
}

/** Assert certificate payload field 5 matches Go sealer parse rules. */
export function assertDelegatedKeyInCertificate(certificate: Uint8Array): void {
  const { payloadBytes } = decodeCoseSign1Parts(certificate);
  const payloadMap = normalizeIntKeyedMap(decode(payloadBytes));
  parseDelegatedCoseKeyFromPayload(payloadMap.get(PAYLOAD_DELEGATED_KEY));
}

export function decodeCoseSign1Parts(certificate: Uint8Array): {
  protectedBytes: Uint8Array;
  payloadBytes: Uint8Array;
  signature: Uint8Array;
} {
  const cert = decode(certificate) as unknown[];
  if (!Array.isArray(cert) || cert.length !== 4) {
    throw new Error("delegation certificate must be COSE_Sign1 array");
  }
  return {
    protectedBytes: bytesFromUnknown(cert[0], "protected"),
    payloadBytes: bytesFromUnknown(cert[2], "payload"),
    signature: bytesFromUnknown(cert[3], "signature"),
  };
}
