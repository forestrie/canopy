/**
 * COSE_Sign1 decomposition and delegated-key parsing. Integer-key map
 * normalization and payload field 5 rules must stay aligned with arbor
 * [delegationcert](https://github.com/forestrie/arbor/tree/main/services/pkgs/delegationcert)
 * — sealer rejects nested-bstr field 5 and non-EC2 keys.
 */

import { decodeCborDeterministic } from "@forestrie/encoding";
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

/**
 * Coerce decoded CBOR into a numeric-key map as required by the Forestrie
 * delegation profile (Go `mapsAsObjects: false` equivalent).
 *
 * @param raw - Decoded CBOR map (JS Map or plain object).
 * @throws When keys are not integers or value is not map-like.
 */
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

/**
 * Parse payload label 5: inline integer-key COSE_Key for the delegated EC2
 * P-256 checkpoint signing key.
 *
 * @param raw - Decoded payload field 5 value (must be inline map, not bstr).
 * @throws When kty/crv/coordinates violate the Forestrie delegation profile.
 */
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

/**
 * Decode standalone CBOR COSE_Key bytes into an inline map for embedding in
 * payload label 5 during certificate assembly.
 *
 * @param bytes - CBOR-encoded integer-key COSE_Key from sealer or coordinator
 *   request bodies.
 */
export function decodeDelegatedCoseKeyFromBytes(
  bytes: Uint8Array,
): Map<number, unknown> {
  const raw = decodeCborDeterministic(bytes);
  return normalizeIntKeyedMap(raw);
}

/**
 * Validate payload field 5 shape without extracting coordinates — used by
 * contract tests that mirror Go sealer parse rules.
 *
 * @param certificate - Full COSE_Sign1 delegation certificate.
 * @throws When field 5 is not an inline EC2 P-256 COSE_Key map.
 */
export function assertDelegatedKeyInCertificate(certificate: Uint8Array): void {
  const { payloadBytes } = decodeCoseSign1Parts(certificate);
  const payloadMap = normalizeIntKeyedMap(
    decodeCborDeterministic(payloadBytes),
  );
  parseDelegatedCoseKeyFromPayload(payloadMap.get(PAYLOAD_DELEGATED_KEY));
}

/**
 * Split an untagged COSE_Sign1 array into protected, payload, and signature
 * bstr components.
 *
 * @param certificate - CBOR COSE_Sign1 `[protected, {}, payload, signature]`.
 * @returns Raw bstr parts for Sig_structure reconstruction and parsing.
 * @throws When outer array length is not four.
 */
export function decodeCoseSign1Parts(certificate: Uint8Array): {
  protectedBytes: Uint8Array;
  payloadBytes: Uint8Array;
  signature: Uint8Array;
} {
  const cert = decodeCborDeterministic(certificate) as unknown[];
  if (!Array.isArray(cert) || cert.length !== 4) {
    throw new Error("delegation certificate must be COSE_Sign1 array");
  }
  return {
    protectedBytes: bytesFromUnknown(cert[0], "protected"),
    payloadBytes: bytesFromUnknown(cert[2], "payload"),
    signature: bytesFromUnknown(cert[3], "signature"),
  };
}
