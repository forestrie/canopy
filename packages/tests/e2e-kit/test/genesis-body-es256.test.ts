import { describe, expect, it } from "vitest";
import { decode as decodeCbor } from "cbor-x";
import { genesisBodyEs256 } from "../src/genesis-body-es256.js";
import {
	FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
	FOREST_GENESIS_LABEL_CHAIN_ID,
	FOREST_GENESIS_LABEL_GENESIS_ALG,
	FOREST_GENESIS_LABEL_GENESIS_VERSION,
	FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
	FOREST_GENESIS_SCHEMA_V2,
} from "../src/wire/forest/forest-genesis-labels.js";
import { COSE_ALG_ES256 } from "../src/wire/cose/cose-key.js";

describe("genesisBodyEs256", () => {
	it("encodes v2 genesis map with ES256 alg and chain binding fields", () => {
		const bootstrapKey = new Uint8Array([1, 2, 3]);
		const univocityAddr = new Uint8Array(20).fill(0xab);
		const chainId = "84532";
		const body = genesisBodyEs256(bootstrapKey, univocityAddr, chainId);
		const map = decodeCbor(body) as Map<number, unknown>;
		expect(map.get(FOREST_GENESIS_LABEL_GENESIS_VERSION)).toBe(
			FOREST_GENESIS_SCHEMA_V2,
		);
		expect(map.get(FOREST_GENESIS_LABEL_GENESIS_ALG)).toBe(COSE_ALG_ES256);
		expect(map.get(FOREST_GENESIS_LABEL_BOOTSTRAP_KEY)).toEqual(bootstrapKey);
		expect(map.get(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR)).toEqual(
			univocityAddr,
		);
		expect(map.get(FOREST_GENESIS_LABEL_CHAIN_ID)).toBe(chainId);
	});
});
