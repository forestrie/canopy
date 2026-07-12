import { encodeCborDeterministic } from "@forestrie/encoding";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_SCHEMA_V2,
} from "./wire/forest/forest-genesis-labels.js";
import { COSE_ALG_ES256 } from "./wire/cose/cose-key.js";

export function genesisBodyEs256(
  bootstrapKey: Uint8Array,
  univocityAddr: Uint8Array,
  chainId: string,
): Uint8Array {
  return encodeCborDeterministic(
    new Map<number, unknown>([
      [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
      [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_ES256],
      [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, bootstrapKey],
      [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, univocityAddr],
      [FOREST_GENESIS_LABEL_CHAIN_ID, chainId],
    ]),
  );
}
