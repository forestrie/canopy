/**
 * Validates runner-submitted BYOK delegation material before persistence.
 * Mirrors arbor delegationcert rules for payload field 5 (integer-key COSE_Key).
 */

import { decode } from "cbor-x";
import { encodeSigStructure } from "@canopy/encoding";

const PAYLOAD_LOG_ID = 1;
const PAYLOAD_MMR_START = 3;
const PAYLOAD_MMR_END = 4;
const PAYLOAD_DELEGATED_KEY = 5;

const COSE_KTY = 1;
const COSE_CRV = -1;
const COSE_X = -2;
const COSE_Y = -3;
const COSE_KTY_EC2 = 2;
const COSE_CRV_P256 = 1;

export interface PublicRootXY {
  alg: string;
  x: Uint8Array;
  y: Uint8Array;
}

export class ByokMaterialValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ByokMaterialValidationError";
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function bytesFromUnknown(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new ByokMaterialValidationError(`${label} is not bytes`);
}

function normalizeIntKeyedMap(raw: unknown): Map<number, unknown> {
  if (raw instanceof Map) {
    return new Map(
      [...raw.entries()].map(([key, value]) => {
        const numericKey = Number(key);
        if (!Number.isInteger(numericKey)) {
          throw new ByokMaterialValidationError(
            `map key ${String(key)} is not an integer`,
          );
        }
        return [numericKey, value];
      }),
    );
  }
  if (raw && typeof raw === "object") {
    const out = new Map<number, unknown>();
    for (const [key, value] of Object.entries(raw)) {
      const numericKey = Number(key);
      if (!Number.isInteger(numericKey)) {
        throw new ByokMaterialValidationError(
          `map key ${key} is not an integer`,
        );
      }
      out.set(numericKey, value);
    }
    return out;
  }
  throw new ByokMaterialValidationError("delegated COSE_Key is not a map");
}

function parseDelegatedCoseKeyFromPayload(
  raw: unknown,
): { x: Uint8Array; y: Uint8Array } {
  const m = normalizeIntKeyedMap(raw);
  const kty = Number(m.get(COSE_KTY));
  if (kty !== COSE_KTY_EC2) {
    throw new ByokMaterialValidationError("delegated public key: expected kty EC2");
  }
  const crv = Number(m.get(COSE_CRV));
  if (crv !== COSE_CRV_P256) {
    throw new ByokMaterialValidationError(
      "delegated public key: unsupported crv",
    );
  }
  const x = bytesFromUnknown(m.get(COSE_X), "delegated key x");
  const y = bytesFromUnknown(m.get(COSE_Y), "delegated key y");
  if (x.length !== 32 || y.length !== 32) {
    throw new ByokMaterialValidationError(
      "delegated public key: x and y must be 32 bytes",
    );
  }
  return { x, y };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function importEs256PublicKey(x: Uint8Array, y: Uint8Array): Promise<CryptoKey> {
  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  raw.set(x, 1);
  raw.set(y, 33);
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(raw),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
}

export async function validateByokDelegationMaterial(opts: {
  logIdHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
  certificate: Uint8Array;
  publicRoot: PublicRootXY;
}): Promise<void> {
  if (opts.publicRoot.alg !== "ES256") {
    throw new ByokMaterialValidationError(
      `unsupported public root alg ${opts.publicRoot.alg}`,
    );
  }

  const cert = decode(opts.certificate) as unknown[];
  if (!Array.isArray(cert) || cert.length !== 4) {
    throw new ByokMaterialValidationError(
      "certificate must be COSE_Sign1 array",
    );
  }

  const protectedBytes = bytesFromUnknown(cert[0], "protected");
  const payloadBytes = bytesFromUnknown(cert[2], "payload");
  const signature = bytesFromUnknown(cert[3], "signature");
  if (signature.length !== 64) {
    throw new ByokMaterialValidationError("signature must be 64 bytes");
  }

  const rootKey = await importEs256PublicKey(
    opts.publicRoot.x,
    opts.publicRoot.y,
  );
  const sigStructure = encodeSigStructure(
    protectedBytes,
    new Uint8Array(),
    payloadBytes,
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    rootKey,
    toArrayBuffer(signature),
    toArrayBuffer(sigStructure),
  );
  if (!ok) {
    throw new ByokMaterialValidationError(
      "delegation certificate signature invalid",
    );
  }

  const payloadMap = normalizeIntKeyedMap(decode(payloadBytes));
  const logId = payloadMap.get(PAYLOAD_LOG_ID);
  if (typeof logId !== "string" || logId !== opts.logIdHex32) {
    throw new ByokMaterialValidationError("payload log id mismatch");
  }
  if (Number(payloadMap.get(PAYLOAD_MMR_START)) !== opts.mmrStart) {
    throw new ByokMaterialValidationError("payload mmrStart mismatch");
  }
  if (Number(payloadMap.get(PAYLOAD_MMR_END)) !== opts.mmrEnd) {
    throw new ByokMaterialValidationError("payload mmrEnd mismatch");
  }

  const { x, y } = parseDelegatedCoseKeyFromPayload(
    payloadMap.get(PAYLOAD_DELEGATED_KEY),
  );
  const submitted = parseDelegatedCoseKeyFromPayload(
    decode(opts.delegatedPublicKey),
  );
  if (
    !bytesEqual(x, submitted.x) ||
    !bytesEqual(y, submitted.y)
  ) {
    throw new ByokMaterialValidationError(
      "delegatedPublicKey does not match certificate payload",
    );
  }
}
