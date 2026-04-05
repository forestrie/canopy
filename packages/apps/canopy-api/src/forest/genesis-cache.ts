/**
 * In-memory cache of parsed forest genesis documents from R2_GRANTS.
 * Used by SCRAPI routes scoped by bootstrap log id in the URL path.
 */

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
} from "../cose/cose-key.js";
import { logIdToWireBytes, wireLogIdToHex64 } from "../grant/log-id-wire.js";
import {
  decodeBodyAsIntKeyMap,
  bytesEqual,
} from "../cbor-api/cbor-map-utils.js";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS,
} from "./forest-genesis-labels.js";

export interface GenesisCacheEnv {
  R2_GRANTS: R2Bucket;
}

export interface ParsedForestGenesis {
  wire: Uint8Array;
  x: Uint8Array;
  y: Uint8Array;
  univocityAddr: Uint8Array | null;
  chainIds: number[] | null;
}

const cache = new Map<string, ParsedForestGenesis>();

function asUint8Array(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
}

function parseUnivocityAddr(v: unknown): Uint8Array | null | "invalid" {
  if (v === null || v === undefined) return null;
  const b = asUint8Array(v);
  if (!b) return "invalid";
  if (b.length !== 20) return "invalid";
  return b;
}

function parseChainIds(v: unknown): number[] | null | "invalid" {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return "invalid";
  if (v.length === 0) return "invalid";
  const out: number[] = [];
  for (const item of v) {
    const n =
      typeof item === "bigint"
        ? Number(item)
        : typeof item === "number"
          ? item
          : Number(item);
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return "invalid";
    out.push(n);
  }
  return out;
}

/**
 * Parse and validate genesis CBOR bytes as stored by {@link postForestGenesis}.
 * @returns null if the map is invalid.
 */
export function parseGenesisCborBytes(
  bytes: Uint8Array,
  expectedWire: Uint8Array,
): ParsedForestGenesis | null {
  let raw: unknown;
  try {
    raw = decodeCbor(bytes);
  } catch {
    return null;
  }
  const m = decodeBodyAsIntKeyMap(raw);
  if (!m) return null;

  const kty = m.get(COSE_KEY_KTY);
  const crv = m.get(COSE_EC2_CRV);
  const x = asUint8Array(m.get(COSE_EC2_X));
  const y = asUint8Array(m.get(COSE_EC2_Y));
  if (kty !== COSE_KTY_EC2 || crv !== COSE_CRV_P256) return null;
  if (!x || x.length !== 32 || !y || y.length !== 32) return null;

  const alg = m.get(COSE_KEY_ALG);
  if (alg !== undefined && alg !== COSE_ALG_ES256) return null;

  const boot = asUint8Array(m.get(FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID));
  if (!boot || boot.length !== 32 || !bytesEqual(boot, expectedWire)) {
    return null;
  }

  const addrRes = parseUnivocityAddr(
    m.get(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR),
  );
  if (addrRes === "invalid") return null;
  const chainRes = parseChainIds(
    m.get(FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS),
  );
  if (chainRes === "invalid") return null;

  const allowed = new Set([
    COSE_KEY_KTY,
    COSE_EC2_CRV,
    COSE_EC2_X,
    COSE_EC2_Y,
    COSE_KEY_ALG,
    FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID,
    FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
    FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS,
  ]);
  for (const k of m.keys()) {
    if (!allowed.has(k)) return null;
  }

  return {
    wire: expectedWire,
    x,
    y,
    univocityAddr: addrRes,
    chainIds: chainRes,
  };
}

export type GenesisLookupResult =
  | ParsedForestGenesis
  | { kind: "bad_segment" }
  | { kind: "not_found" }
  | { kind: "corrupt" };

/**
 * Load genesis for a bootstrap log-id path segment: cache, then R2.
 */
export async function getParsedGenesis(
  logIdRouteSegment: string,
  env: GenesisCacheEnv,
): Promise<GenesisLookupResult> {
  let wire: Uint8Array;
  try {
    wire = logIdToWireBytes(logIdRouteSegment);
  } catch {
    return { kind: "bad_segment" };
  }
  const hex64 = wireLogIdToHex64(wire);
  const hit = cache.get(hex64);
  if (hit) return hit;

  const key = `forest/${hex64}/genesis.cbor`;
  const obj = await env.R2_GRANTS.get(key);
  if (!obj) return { kind: "not_found" };

  const bytes = new Uint8Array(await obj.arrayBuffer());
  const parsed = parseGenesisCborBytes(bytes, wire);
  if (!parsed) return { kind: "corrupt" };

  cache.set(hex64, parsed);
  return parsed;
}

/** Test-only: clear in-memory genesis cache. */
export function clearGenesisCacheForTests(): void {
  cache.clear();
}
