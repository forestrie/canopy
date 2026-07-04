import { decode as decodeCbor } from "cbor-x";
import {
  COSE_ALG_ES256,
  COSE_CRV_P256,
  COSE_EC2_CRV,
  COSE_EC2_X,
  COSE_EC2_Y,
  COSE_KEY_ALG,
  COSE_KEY_KTY,
  COSE_KTY_EC2,
} from "./cose-key.js";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_SCHEMA_V1,
  FOREST_GENESIS_SCHEMA_V2,
} from "./forest-genesis-labels.js";
import { decodeTrustRootCbor } from "./decode-trust-root-cbor.js";
import type { RootVerifyKey } from "./root-verify-key.js";

function decodeBodyAsIntKeyMap(raw: unknown): Map<number, unknown> | null {
  if (raw instanceof Map) return raw as Map<number, unknown>;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const out = new Map<number, unknown>();
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const n = Number(k);
      if (Number.isFinite(n)) out.set(n, v);
    }
    return out;
  }
  return null;
}

function asGenesisUint8Array(v: unknown): Uint8Array | null {
  return v instanceof Uint8Array ? v : null;
}

/**
 * Extract receipt verify key from a forest genesis document CBOR blob.
 * Offline path: genesis-only trust anchor (ADR-0045).
 */
export async function decodeTrustRootFromGenesis(
  genesisCbor: Uint8Array,
): Promise<RootVerifyKey> {
  let raw: unknown;
  try {
    raw = decodeCbor(genesisCbor);
  } catch {
    throw new Error("genesis CBOR decode failed");
  }
  const m = decodeBodyAsIntKeyMap(raw);
  if (!m) throw new Error("genesis document must be a CBOR map");

  const versionRaw = m.get(FOREST_GENESIS_LABEL_GENESIS_VERSION);
  if (versionRaw === FOREST_GENESIS_SCHEMA_V2) {
    const alg = m.get(FOREST_GENESIS_LABEL_GENESIS_ALG);
    const bootstrapKey = asGenesisUint8Array(
      m.get(FOREST_GENESIS_LABEL_BOOTSTRAP_KEY),
    );
    if (bootstrapKey === null) {
      throw new Error("v2 genesis missing bootstrapKey");
    }
    return decodeTrustRootCbor({ alg, key: bootstrapKey });
  }

  const kty = m.get(COSE_KEY_KTY);
  const crv = m.get(COSE_EC2_CRV);
  const x = asGenesisUint8Array(m.get(COSE_EC2_X));
  const y = asGenesisUint8Array(m.get(COSE_EC2_Y));
  if (kty === COSE_KTY_EC2 && crv === COSE_CRV_P256 && x && y) {
    const alg = m.get(COSE_KEY_ALG);
    if (alg !== undefined && alg !== COSE_ALG_ES256) {
      throw new Error("genesis EC2 key must be ES256");
    }
    const xy = new Uint8Array(64);
    xy.set(x, 0);
    xy.set(y, 32);
    return decodeTrustRootCbor({ alg: COSE_ALG_ES256, key: xy });
  }

  if (versionRaw === FOREST_GENESIS_SCHEMA_V1 || versionRaw === undefined) {
    throw new Error("unsupported or invalid genesis schema for trust root");
  }

  throw new Error("unsupported genesis document");
}
