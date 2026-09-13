import { decodeCborDeterministic } from "@forestrie/encoding";
import {
  asGenesisUint8Array,
  decodeGenesisBodyAsIntKeyMap,
} from "./decode-genesis-cbor-map.js";
import {
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_LOG_ID,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_SCHEMA_V2,
} from "./forest-genesis-labels.js";
import type { ChainBinding } from "./chain-binding.js";

function bytesToLowerHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Decode the chain binding — univocity contract address, chain id, and the
 * forest's own log id — out of a forest genesis document CBOR blob (labels
 * -68011 / -68013 / -68010). Mirrors mcp-resolve's `genesis-binding.ts`
 * `decodeChainBindingFromGenesis` (plan-2609-07 L3) so that consumer can
 * delete its own copy, except `logId` here stays the raw 32-byte wire value
 * rather than being reformatted as a UUID string.
 *
 * Throws a plain `Error` for any genesis document that does not decode into
 * a usable chain binding: not CBOR, not a map, wrong schema version, or a
 * label absent or mis-sized/mistyped.
 */
export function decodeChainBindingFromGenesis(
  genesis: Uint8Array,
): ChainBinding {
  let raw: unknown;
  try {
    raw = decodeCborDeterministic(genesis);
  } catch (err) {
    throw new Error(
      `genesis CBOR decode failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const m = decodeGenesisBodyAsIntKeyMap(raw);
  if (!m) throw new Error("genesis document must be a CBOR map");

  const versionRaw = m.get(FOREST_GENESIS_LABEL_GENESIS_VERSION);
  if (versionRaw === undefined) {
    throw new Error("genesis version label absent");
  }
  const version =
    typeof versionRaw === "bigint" ? Number(versionRaw) : versionRaw;
  if (version !== FOREST_GENESIS_SCHEMA_V2) {
    throw new Error(
      `genesis version ${String(version)} is not ${FOREST_GENESIS_SCHEMA_V2}`,
    );
  }

  const addr = asGenesisUint8Array(m.get(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR));
  if (!addr || addr.length !== 20) {
    throw new Error("univocity address label absent or not 20 bytes");
  }

  const chainIdRaw = m.get(FOREST_GENESIS_LABEL_CHAIN_ID);
  if (typeof chainIdRaw !== "string" || !/^[0-9]+$/.test(chainIdRaw)) {
    throw new Error("chain id label absent or not a decimal string");
  }

  const logId = asGenesisUint8Array(m.get(FOREST_GENESIS_LABEL_LOG_ID));
  if (!logId || logId.length !== 32) {
    throw new Error("log id label absent or not 32 bytes");
  }

  return {
    univocity: `0x${bytesToLowerHex(addr)}`,
    chainId: Number(chainIdRaw),
    logId,
  };
}
