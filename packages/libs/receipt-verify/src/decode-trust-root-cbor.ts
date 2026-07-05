import { COSE_ALG_ES256, COSE_ALG_KS256 } from "@canopy/encoding";
import type { ParsedVerifyKey } from "@canopy/encoding";
import {
  isParsedKs256RootKey,
  type ParsedKs256RootKey,
  type RootVerifyKey,
} from "./root-verify-key.js";

export async function importEs256PublicKeyFromGrantDataXy64(
  xy: Uint8Array,
): Promise<CryptoKey> {
  if (xy.length !== 64) {
    throw new Error(
      "ES256 grantData must be 64 bytes (x||y) for raw public key import",
    );
  }
  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  raw.set(xy, 1);
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

function asUint8Array(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  return null;
}

function parseAlgInt(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "bigint") {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isInteger(n)) return n;
  }
  return null;
}

function ks256RootFromAddress(address: Uint8Array): ParsedKs256RootKey {
  return { kind: "KS256", alg: COSE_ALG_KS256, address };
}

function recordToTrustRootFields(decoded: unknown): Record<string, unknown> {
  if (decoded instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of decoded.entries()) {
      out[String(k)] = v;
    }
    return out;
  }
  if (typeof decoded === "object" && decoded !== null) {
    return decoded as Record<string, unknown>;
  }
  throw new Error("trust-root CBOR must be a map");
}

export async function decodeTrustRootCbor(
  decoded: unknown,
): Promise<RootVerifyKey> {
  const fields = recordToTrustRootFields(decoded);
  const algRaw = fields.alg;
  const key = asUint8Array(fields.key);
  const algInt = parseAlgInt(algRaw);

  if (algInt === COSE_ALG_KS256) {
    if (!key || key.length !== 20) {
      throw new Error("KS256 trust-root key must be 20 bytes");
    }
    return ks256RootFromAddress(key);
  }

  if (algInt === COSE_ALG_ES256 && key) {
    if (key.length !== 64) {
      throw new Error("ES256 trust-root key must be 64 bytes (x||y)");
    }
    return importEs256PublicKeyFromGrantDataXy64(key);
  }

  if (typeof algRaw === "string" && algRaw.toUpperCase() === "KS256") {
    if (!key || key.length !== 20) {
      throw new Error("KS256 trust-root key must be 20 bytes");
    }
    return ks256RootFromAddress(key);
  }

  if (typeof algRaw === "string" && algRaw.toUpperCase() === "ES256") {
    const x = asUint8Array(fields.x);
    const y = asUint8Array(fields.y);
    if (!x || x.length !== 32 || !y || y.length !== 32) {
      throw new Error("ES256 trust-root x/y must be 32 bytes each");
    }
    const xy = new Uint8Array(64);
    xy.set(x, 0);
    xy.set(y, 32);
    return importEs256PublicKeyFromGrantDataXy64(xy);
  }

  throw new Error(`unsupported trust-root alg ${String(algRaw)}`);
}

export function es256ReceiptVerifyKeys(
  keys: RootVerifyKey[],
): ParsedVerifyKey[] {
  return keys.filter((k): k is CryptoKey => !isParsedKs256RootKey(k));
}
