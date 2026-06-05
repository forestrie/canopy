/**
 * Helpers for genesis v1 POST bodies in unit tests.
 */

import {
  COSE_ALG_ES256,
  COSE_CRV_P256,
  COSE_EC2_CRV,
  COSE_EC2_X,
  COSE_EC2_Y,
  COSE_KEY_ALG,
  COSE_KEY_KTY,
  COSE_KTY_EC2,
} from "../../src/cose/cose-key.js";
import {
  FOREST_GENESIS_E2E_DUMMY_CHAIN_ID,
  FOREST_GENESIS_E2E_DUMMY_UNIVOCITY_ADDR,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_SCHEMA_V1,
} from "../../src/forest/forest-genesis-labels.js";

export {
  FOREST_GENESIS_E2E_DUMMY_CHAIN_ID,
  FOREST_GENESIS_E2E_DUMMY_UNIVOCITY_ADDR,
};

/** v1 POST body map with dummy chain binding and default x/y fills. */
export function validGenesisV1CborMap(opts?: {
  x?: Uint8Array;
  y?: Uint8Array;
  univocityAddr?: Uint8Array;
  chainId?: string;
}): Map<number, unknown> {
  const x = opts?.x ?? new Uint8Array(32).fill(0x3a);
  const y = opts?.y ?? new Uint8Array(32).fill(0x4b);
  return new Map<number, unknown>([
    [COSE_KEY_KTY, COSE_KTY_EC2],
    [COSE_EC2_CRV, COSE_CRV_P256],
    [COSE_EC2_X, x],
    [COSE_EC2_Y, y],
    [COSE_KEY_ALG, COSE_ALG_ES256],
    [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V1],
    [
      FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
      opts?.univocityAddr ?? FOREST_GENESIS_E2E_DUMMY_UNIVOCITY_ADDR,
    ],
    [FOREST_GENESIS_LABEL_CHAIN_ID, opts?.chainId ?? FOREST_GENESIS_E2E_DUMMY_CHAIN_ID],
  ]);
}
