import { COSE_ALG_ES256, COSE_ALG_KS256 } from "../../src/cose/cose-key.js";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_SCHEMA_V2,
} from "../../src/forest/forest-genesis-labels.js";

/** Inline unit-test chain binding (not a deployed contract). */
const TEST_GENESIS_UNIVOCITY_ADDR = new Uint8Array(20).fill(0x42);
const TEST_GENESIS_CHAIN_ID = "84532";

/** Valid v2 ES256 genesis POST body for pool / integration tests. */
export function validGenesisV2Es256CborMap(opts?: {
  bootstrapKey?: Uint8Array;
  univocityAddr?: Uint8Array;
  chainId?: string;
}): Map<number, unknown> {
  const key = opts?.bootstrapKey ?? new Uint8Array(64).fill(0x11);
  return new Map<number, unknown>([
    [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
    [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_ES256],
    [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, key],
    [
      FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
      opts?.univocityAddr ?? TEST_GENESIS_UNIVOCITY_ADDR,
    ],
    [FOREST_GENESIS_LABEL_CHAIN_ID, opts?.chainId ?? TEST_GENESIS_CHAIN_ID],
  ]);
}

/** Valid v2 KS256 genesis POST body for coordinator-forward tests. */
export function validGenesisV2Ks256CborMap(opts?: {
  bootstrapKey?: Uint8Array;
  univocityAddr?: Uint8Array;
  chainId?: string;
}): Map<number, unknown> {
  const key = opts?.bootstrapKey ?? new Uint8Array(20).fill(0xaa);
  return new Map<number, unknown>([
    [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
    [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_KS256],
    [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, key],
    [
      FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
      opts?.univocityAddr ?? TEST_GENESIS_UNIVOCITY_ADDR,
    ],
    [FOREST_GENESIS_LABEL_CHAIN_ID, opts?.chainId ?? TEST_GENESIS_CHAIN_ID],
  ]);
}
