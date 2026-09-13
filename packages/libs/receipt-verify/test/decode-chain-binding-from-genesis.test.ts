import { readFileSync } from "node:fs";
import { encodeCborDeterministic } from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
import { decodeChainBindingFromGenesis } from "../src/decode-chain-binding-from-genesis.js";
import {
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_LOG_ID,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_SCHEMA_V2,
} from "../src/forest-genesis-labels.js";
import {
  buildGenesisCbor,
  uuidToBytes,
} from "./helpers/grant-receipt-fixture.js";
import { toPaddedWire32 } from "../src/uuid-bytes.js";

// LANE_A_GENESIS_SHA256 is asserted against manifest.json below, not just
// trusted — see plan-2609-07 L3 and the copied lane-a/PROVENANCE.md.
const LANE_A_GENESIS_SHA256 =
  "c6183184d805bf23652a265d7f533101eec5c97e1939dd90c7f142e6d502da68";

function buildGenesisMap(
  fields: Partial<
    Record<
      | typeof FOREST_GENESIS_LABEL_GENESIS_VERSION
      | typeof FOREST_GENESIS_LABEL_UNIVOCITY_ADDR
      | typeof FOREST_GENESIS_LABEL_CHAIN_ID
      | typeof FOREST_GENESIS_LABEL_LOG_ID,
      unknown
    >
  >,
): Uint8Array {
  const map = new Map<number, unknown>(
    Object.entries(fields).map(([k, v]) => [Number(k), v]),
  );
  return encodeCborDeterministic(map);
}

describe("decodeChainBindingFromGenesis", () => {
  it("round-trips a genesis built with the shared test fixture helper", async () => {
    const univocity20 = new Uint8Array(20).fill(0xab);
    const logId = "660e8400-e29b-41d4-a716-446655440001";
    const bootstrapKey = new Uint8Array(64).fill(1);
    const genesis = buildGenesisCbor(bootstrapKey, logId);

    const binding = decodeChainBindingFromGenesis(genesis);

    expect(binding.univocity).toBe(
      `0x${Buffer.from(univocity20).toString("hex")}`,
    );
    expect(binding.chainId).toBe(84532);
    expect(binding.logId).toEqual(toPaddedWire32(uuidToBytes(logId)));
    expect(binding.logId.length).toBe(32);
  });

  it("decodes the lane-a genesis fixture's chain binding", async () => {
    const genesisPath = new URL(
      "./fixtures/lane-a/genesis.cbor",
      import.meta.url,
    );
    const genesis = new Uint8Array(readFileSync(genesisPath));

    const sha256 = Buffer.from(
      await crypto.subtle.digest("SHA-256", genesis as unknown as BufferSource),
    ).toString("hex");
    expect(sha256).toBe(LANE_A_GENESIS_SHA256);

    const manifest = JSON.parse(
      readFileSync(
        new URL("./fixtures/lane-a/manifest.json", import.meta.url),
        "utf8",
      ),
    ) as { files: Record<string, string> };
    expect(manifest.files["genesis.cbor"]).toBe(LANE_A_GENESIS_SHA256);

    const binding = decodeChainBindingFromGenesis(genesis);

    // Expected values per test/fixtures/chain/PROVENANCE.md in mcp-resolve
    // (plan-2609-05 step 2.2): chain id and univocity address are the
    // forest's, bound at genesis; the -68010 label carries the forest's
    // own bootstrap log id (67876864-3b46-67ae-dcb3-13cc81624aa5), whose
    // 16 bytes are also the leading 16 bytes of the univocity address.
    expect(binding.univocity).toBe(
      "0x678768643b4667aedcb313cc81624aa560b7f0ca",
    );
    expect(binding.chainId).toBe(84532);
    expect(binding.logId.length).toBe(32);
    expect(Buffer.from(binding.logId).toString("hex")).toBe(
      "00000000000000000000000000000000678768643b4667aedcb313cc81624aa5",
    );
    // The forest bootstrap log id, as a UUID, is the last 16 bytes.
    expect(Buffer.from(binding.logId.slice(16)).toString("hex")).toBe(
      "678768643b4667aedcb313cc81624aa5",
    );
  });

  it("throws when the version label is absent", () => {
    const genesis = buildGenesisMap({
      [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR]: new Uint8Array(20).fill(1),
      [FOREST_GENESIS_LABEL_CHAIN_ID]: "84532",
      [FOREST_GENESIS_LABEL_LOG_ID]: new Uint8Array(32).fill(2),
    });
    expect(() => decodeChainBindingFromGenesis(genesis)).toThrow(
      /version label absent/,
    );
  });

  it("throws on a version-1 genesis", () => {
    const genesis = buildGenesisMap({
      [FOREST_GENESIS_LABEL_GENESIS_VERSION]: 1,
      [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR]: new Uint8Array(20).fill(1),
      [FOREST_GENESIS_LABEL_CHAIN_ID]: "84532",
      [FOREST_GENESIS_LABEL_LOG_ID]: new Uint8Array(32).fill(2),
    });
    expect(() => decodeChainBindingFromGenesis(genesis)).toThrow(/is not 2/);
  });

  it("throws when not a CBOR map", () => {
    expect(() =>
      decodeChainBindingFromGenesis(encodeCborDeterministic([1, 2, 3])),
    ).toThrow(/must be a CBOR map/);
  });

  it("throws when not valid CBOR", () => {
    expect(() =>
      decodeChainBindingFromGenesis(new Uint8Array([0xff, 0xff, 0xff])),
    ).toThrow(/genesis CBOR decode failed/);
  });

  it("throws when the univocity address is the wrong size", () => {
    const genesis = buildGenesisMap({
      [FOREST_GENESIS_LABEL_GENESIS_VERSION]: FOREST_GENESIS_SCHEMA_V2,
      [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR]: new Uint8Array(19).fill(1),
      [FOREST_GENESIS_LABEL_CHAIN_ID]: "84532",
      [FOREST_GENESIS_LABEL_LOG_ID]: new Uint8Array(32).fill(2),
    });
    expect(() => decodeChainBindingFromGenesis(genesis)).toThrow(
      /univocity address label absent or not 20 bytes/,
    );
  });

  it("throws when the chain id is not a decimal string", () => {
    const genesis = buildGenesisMap({
      [FOREST_GENESIS_LABEL_GENESIS_VERSION]: FOREST_GENESIS_SCHEMA_V2,
      [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR]: new Uint8Array(20).fill(1),
      [FOREST_GENESIS_LABEL_CHAIN_ID]: 84532,
      [FOREST_GENESIS_LABEL_LOG_ID]: new Uint8Array(32).fill(2),
    });
    expect(() => decodeChainBindingFromGenesis(genesis)).toThrow(
      /chain id label absent or not a decimal string/,
    );
  });

  it("throws when the log id label is absent", () => {
    const genesis = buildGenesisMap({
      [FOREST_GENESIS_LABEL_GENESIS_VERSION]: FOREST_GENESIS_SCHEMA_V2,
      [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR]: new Uint8Array(20).fill(1),
      [FOREST_GENESIS_LABEL_CHAIN_ID]: "84532",
    });
    expect(() => decodeChainBindingFromGenesis(genesis)).toThrow(
      /log id label absent or not 32 bytes/,
    );
  });

  it("throws when the log id label is the wrong size", () => {
    const genesis = buildGenesisMap({
      [FOREST_GENESIS_LABEL_GENESIS_VERSION]: FOREST_GENESIS_SCHEMA_V2,
      [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR]: new Uint8Array(20).fill(1),
      [FOREST_GENESIS_LABEL_CHAIN_ID]: "84532",
      [FOREST_GENESIS_LABEL_LOG_ID]: new Uint8Array(16).fill(2),
    });
    expect(() => decodeChainBindingFromGenesis(genesis)).toThrow(
      /log id label absent or not 32 bytes/,
    );
  });
});
