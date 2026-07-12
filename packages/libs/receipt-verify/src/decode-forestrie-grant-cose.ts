import { sha256 } from "@noble/hashes/sha256";
import { decodeCborDeterministic } from "@forestrie/encoding";
import type { Grant } from "@forestrie/encoding";
import {
  HEADER_FORESTRIE_GRANT_V0,
  HEADER_IDTIMESTAMP,
} from "./forest-genesis-labels.js";
import { decodeGrantPayload } from "./grant-codec.js";

const IDTIMESTAMP_BYTES = 8;

function toHeaderMap(
  value: Map<number, unknown> | Record<string, unknown> | unknown,
): Map<number, unknown> {
  if (value instanceof Map) return value as Map<number, unknown>;
  if (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Uint8Array)
  ) {
    const out = new Map<number, unknown>();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const n = Number(k);
      if (Number.isFinite(n)) out.set(n, v);
    }
    return out;
  }
  return new Map();
}

function digestEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i]! ^ b[i]!;
  return x === 0;
}

/**
 * Decode Forestrie-Grant COSE Sign1 (Custodian transparent statement profile).
 */
export function decodeForestrieGrantCose(bytes: Uint8Array): {
  grant: Grant;
  idtimestampBe8: Uint8Array;
} {
  const raw = decodeCborDeterministic(bytes);
  const arr = Array.isArray(raw) ? raw : null;
  if (!arr || arr.length !== 4) {
    throw new Error("Forestrie-Grant must be COSE Sign1 (array of 4)");
  }
  const [, unprotectedRaw, payloadRaw] = arr as [
    unknown,
    Map<number, unknown> | Record<string, unknown>,
    Uint8Array | null,
    unknown,
  ];
  if (!(payloadRaw instanceof Uint8Array) || payloadRaw.length !== 32) {
    throw new Error("Forestrie-Grant COSE payload must be 32-byte digest");
  }
  const unprotected = toHeaderMap(unprotectedRaw);
  const embedded = unprotected.get(HEADER_FORESTRIE_GRANT_V0);
  if (!(embedded instanceof Uint8Array) || embedded.length === 0) {
    throw new Error("Forestrie-Grant missing unprotected -65538 grant CBOR");
  }
  if (!digestEquals(sha256(embedded), payloadRaw)) {
    throw new Error("Forestrie-Grant digest mismatch");
  }
  const idtimestampVal = unprotected.get(HEADER_IDTIMESTAMP);
  const idtimestampBe8 =
    idtimestampVal instanceof Uint8Array &&
    idtimestampVal.length >= IDTIMESTAMP_BYTES
      ? idtimestampVal.length === IDTIMESTAMP_BYTES
        ? idtimestampVal
        : idtimestampVal.slice(-IDTIMESTAMP_BYTES)
      : new Uint8Array(IDTIMESTAMP_BYTES);
  return {
    grant: decodeGrantPayload(embedded),
    idtimestampBe8: new Uint8Array(idtimestampBe8),
  };
}
