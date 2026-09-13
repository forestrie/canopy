import { decodeCborDeterministic } from "@forestrie/encoding";
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
import { isParsedKs256RootKey } from "./root-verify-key.js";
import {
  asGenesisUint8Array,
  decodeGenesisBodyAsIntKeyMap,
} from "./decode-genesis-cbor-map.js";
import type { DecodedTrustRoot } from "./decoded-trust-root.js";

/**
 * Extract the receipt verify key from a forest genesis document CBOR blob.
 * Offline path: genesis-only trust anchor (ADR-0045). Returns the decoded
 * key alongside `bootstrapKeyXy` (plan-2609-07 L3) — see
 * {@link DecodedTrustRoot}. Throws if the genesis's bootstrap key is not a
 * P-256 public key (a KS256 on-chain address has no `bootstrapKeyXy`); in
 * practice the genesis-time bootstrap key is always ES256, since KS256
 * verification needs the chain to already exist.
 */
export async function decodeTrustRootFromGenesis(
  genesisCbor: Uint8Array,
): Promise<DecodedTrustRoot> {
  let raw: unknown;
  try {
    raw = decodeCborDeterministic(genesisCbor);
  } catch {
    throw new Error("genesis CBOR decode failed");
  }
  const m = decodeGenesisBodyAsIntKeyMap(raw);
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
    const key = await decodeTrustRootCbor({ alg, key: bootstrapKey });
    if (isParsedKs256RootKey(key)) {
      throw new Error(
        "v2 genesis bootstrap key is KS256 (on-chain address); no P-256 bootstrapKeyXy",
      );
    }
    return { key, bootstrapKeyXy: bootstrapKey };
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
    const key = await decodeTrustRootCbor({ alg: COSE_ALG_ES256, key: xy });
    return { key, bootstrapKeyXy: xy };
  }

  if (versionRaw === FOREST_GENESIS_SCHEMA_V1 || versionRaw === undefined) {
    throw new Error("unsupported or invalid genesis schema for trust root");
  }

  throw new Error("unsupported genesis document");
}
