/**
 * In-memory cache of parsed forest genesis documents from R2_GRANTS.
 * Used by SCRAPI routes scoped by bootstrap log id in the URL path.
 */

import { decode as decodeCbor } from "cbor-x";

import {
  COSE_ALG_ES256,
  COSE_ALG_KS256,
  COSE_CRV_P256,
  COSE_EC2_CRV,
  COSE_EC2_X,
  COSE_EC2_Y,
  COSE_KEY_ALG,
  COSE_KEY_KTY,
  COSE_KTY_EC2,
} from "../cose/cose-key.js";
import {
  logIdToStorageSegment,
  logIdToWireBytes,
  toPaddedWire32,
} from "../grant/log-id-wire.js";
import {
  decodeBodyAsIntKeyMap,
  bytesEqual,
} from "../cbor-api/cbor-map-utils.js";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS,
  FOREST_GENESIS_SCHEMA_V1,
  FOREST_GENESIS_SCHEMA_V2,
} from "./forest-genesis-labels.js";
import {
  asGenesisUint8Array,
  parseChainIdString,
  parseLegacyChainIds,
  parseUnivocityAddrOptional,
  type ForestGenesisChainBinding,
} from "./genesis-wire.js";
import type { GenesisCacheEnv } from "./genesis-cache-env.js";
import type { GenesisLookupResult } from "./genesis-lookup-result.js";
import type { ParsedForestGenesis } from "./parsed-forest-genesis.js";

export type {
  GenesisCacheEnv,
  GenesisLookupResult,
  ParsedForestGenesis,
} from "./types.js";

const cache = new Map<string, ParsedForestGenesis>();

const COSE_KEYS = new Set([
  COSE_KEY_KTY,
  COSE_EC2_CRV,
  COSE_EC2_X,
  COSE_EC2_Y,
  COSE_KEY_ALG,
  FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID,
]);

const V0_EXTRA_KEYS = new Set([
  ...COSE_KEYS,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS,
]);

const V1_EXTRA_KEYS = new Set([
  ...COSE_KEYS,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_LABEL_CHAIN_ID,
]);

const V2_EXTRA_KEYS = new Set([
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_LABEL_CHAIN_ID,
]);

/** True when genesis was written with schema v1 (EC2 COSE_Key + chain binding). */
export function isGenesisV1(genesis: ParsedForestGenesis): boolean {
  return genesis.schemaVersion === 1;
}

/** True when genesis was written with schema v2 (genesisAlg + bootstrapKey). */
export function isGenesisV2(genesis: ParsedForestGenesis): boolean {
  return genesis.schemaVersion === 2;
}

function parseGenesisAlg(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "bigint") {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function parseV2Genesis(
  m: Map<number, unknown>,
  expectedLogId: Uint8Array,
): ParsedForestGenesis | null {
  for (const k of m.keys()) {
    if (!V2_EXTRA_KEYS.has(k)) return null;
  }
  if (m.has(FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS)) return null;

  const boot = asGenesisUint8Array(
    m.get(FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID),
  );
  const expectedPadded = toPaddedWire32(expectedLogId);
  if (!boot || boot.length !== 32 || !bytesEqual(boot, expectedPadded)) {
    return null;
  }

  const bootstrapAlg = parseGenesisAlg(m.get(FOREST_GENESIS_LABEL_GENESIS_ALG));
  const bootstrapKey = asGenesisUint8Array(
    m.get(FOREST_GENESIS_LABEL_BOOTSTRAP_KEY),
  );
  if (bootstrapAlg === null || !bootstrapKey) return null;

  if (bootstrapAlg === COSE_ALG_ES256 && bootstrapKey.length !== 64) {
    return null;
  }
  if (bootstrapAlg === COSE_ALG_KS256 && bootstrapKey.length !== 20) {
    return null;
  }
  if (bootstrapAlg !== COSE_ALG_ES256 && bootstrapAlg !== COSE_ALG_KS256) {
    return null;
  }

  const addr = parseUnivocityAddrOptional(
    m.get(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR),
  );
  if (addr === null || addr === "invalid") return null;

  const chainId = parseChainIdString(m.get(FOREST_GENESIS_LABEL_CHAIN_ID));
  if (chainId === "invalid") return null;

  const parsed: ParsedForestGenesis = {
    wire: expectedLogId,
    schemaVersion: 2,
    chainBinding: { address: addr, chainId },
    bootstrapAlg,
    bootstrapKey,
  };
  if (bootstrapAlg === COSE_ALG_ES256) {
    parsed.x = bootstrapKey.slice(0, 32);
    parsed.y = bootstrapKey.slice(32, 64);
  }
  return parsed;
}

/**
 * Parse and validate genesis CBOR bytes from R2.
 * Accepts v0 (plan-0018), v1 (EC2 + chain binding), and v2 (alg/key).
 * @returns null if the map is invalid.
 */
export function parseGenesisCborBytes(
  bytes: Uint8Array,
  expectedLogId: Uint8Array,
): ParsedForestGenesis | null {
  let raw: unknown;
  try {
    raw = decodeCbor(bytes);
  } catch {
    return null;
  }
  const m = decodeBodyAsIntKeyMap(raw);
  if (!m) return null;

  const boot = asGenesisUint8Array(
    m.get(FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID),
  );
  const expectedPadded = toPaddedWire32(expectedLogId);
  if (!boot || boot.length !== 32 || !bytesEqual(boot, expectedPadded)) {
    return null;
  }

  const versionRaw = m.get(FOREST_GENESIS_LABEL_GENESIS_VERSION);
  const isV2 = versionRaw === FOREST_GENESIS_SCHEMA_V2;
  const isV1 = versionRaw === FOREST_GENESIS_SCHEMA_V1;

  if (versionRaw !== undefined && !isV1 && !isV2) return null;

  if (isV2) {
    return parseV2Genesis(m, expectedLogId);
  }

  const kty = m.get(COSE_KEY_KTY);
  const crv = m.get(COSE_EC2_CRV);
  const x = asGenesisUint8Array(m.get(COSE_EC2_X));
  const y = asGenesisUint8Array(m.get(COSE_EC2_Y));
  if (kty !== COSE_KTY_EC2 || crv !== COSE_CRV_P256) return null;
  if (!x || x.length !== 32 || !y || y.length !== 32) return null;

  const alg = m.get(COSE_KEY_ALG);
  if (alg !== undefined && alg !== COSE_ALG_ES256) return null;

  if (isV1) {
    for (const k of m.keys()) {
      if (!V1_EXTRA_KEYS.has(k)) return null;
    }
    if (m.has(FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS)) return null;

    const addr = parseUnivocityAddrOptional(
      m.get(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR),
    );
    if (addr === null || addr === "invalid") return null;

    const chainId = parseChainIdString(m.get(FOREST_GENESIS_LABEL_CHAIN_ID));
    if (chainId === "invalid") return null;

    return {
      wire: expectedLogId,
      x,
      y,
      schemaVersion: 1,
      chainBinding: { address: addr, chainId },
    };
  }

  for (const k of m.keys()) {
    if (!V0_EXTRA_KEYS.has(k)) return null;
  }

  const addrRes = parseUnivocityAddrOptional(
    m.get(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR),
  );
  if (addrRes === "invalid") return null;
  const legacyChains = parseLegacyChainIds(
    m.get(FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS),
  );
  if (legacyChains === "invalid") return null;

  let chainBinding: ForestGenesisChainBinding | null = null;
  if (addrRes !== null && legacyChains !== null && legacyChains.length > 0) {
    chainBinding = {
      address: addrRes,
      chainId: String(legacyChains[0]),
    };
  }

  return {
    wire: expectedLogId,
    x,
    y,
    schemaVersion: 0,
    chainBinding,
  };
}

/**
 * Load genesis for a bootstrap log-id path segment: cache, then R2.
 */
export async function getParsedGenesis(
  logIdRouteSegment: string,
  env: GenesisCacheEnv,
): Promise<GenesisLookupResult> {
  let logId: Uint8Array;
  try {
    logId = logIdToWireBytes(logIdRouteSegment);
  } catch {
    return { kind: "bad_segment" };
  }
  const storageSeg = logIdToStorageSegment(logId);
  const hit = cache.get(storageSeg);
  if (hit) return hit;

  const key = `forests/forest/${storageSeg}/genesis.cbor`;
  const obj = await env.R2_GRANTS.get(key);
  if (!obj) return { kind: "not_found" };

  const bytes = new Uint8Array(await obj.arrayBuffer());
  const parsed = parseGenesisCborBytes(bytes, logId);
  if (!parsed) return { kind: "corrupt" };

  cache.set(storageSeg, parsed);
  return parsed;
}

/** Test-only: clear in-memory genesis cache. */
export function clearGenesisCacheForTests(): void {
  cache.clear();
}
