import { encodeCborDeterministic } from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_LABEL_UNIVOCITY_DEPLOYER,
  FOREST_GENESIS_LABEL_UNIVOCITY_VARIANT,
  FOREST_GENESIS_SCHEMA_V2,
  FOREST_GENESIS_UNIVOCITY_VARIANT_UUPS_COUNTERFACTUAL,
} from "../src/forest/forest-genesis-labels.js";
import { postForestGenesis } from "../src/forest/post-genesis.js";
import { toPaddedWire32, logIdToWireBytes } from "../src/grant/log-id-wire.js";
import { COSE_ALG_KS256 } from "../src/cose/cose-key.js";

const vector = {
  logId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  expectedProxyAddress: "0xbFb9Ef37B28BD71a89a6D8aFe27eB368CEF17347",
};

const LOG_ID = vector.logId;
const CHAIN_ID = "84532";

function deployerBytes(hex: string): Uint8Array {
  const stripped = hex.slice(2);
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) {
    out[i] = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function proxyBytes(hex: string): Uint8Array {
  return deployerBytes(hex);
}

describe("postForestGenesis uups-counterfactual", () => {
  it("accepts genesis when address matches counterfactual re-derivation", async () => {
    const padded = toPaddedWire32(logIdToWireBytes(LOG_ID));
    const body = new Map<number, unknown>([
      [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
      [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_KS256],
      [
        FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
        deployerBytes("0x1528b86ff561f617602356efdbD05908a07AA788"),
      ],
      [FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID, padded],
      [
        FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
        proxyBytes(vector.expectedProxyAddress),
      ],
      [FOREST_GENESIS_LABEL_CHAIN_ID, CHAIN_ID],
      [
        FOREST_GENESIS_LABEL_UNIVOCITY_VARIANT,
        FOREST_GENESIS_UNIVOCITY_VARIANT_UUPS_COUNTERFACTUAL,
      ],
      [FOREST_GENESIS_LABEL_UNIVOCITY_DEPLOYER, deployerBytes(vector.deployer)],
    ]);

    const r2 = {
      head: async () => null,
      put: async () => undefined,
    } as unknown as R2Bucket;

    const result = await postForestGenesis(
      new Request("http://localhost/genesis", {
        method: "POST",
        headers: { "Content-Type": "application/cbor" },
        body: encodeCborDeterministic(body),
      }),
      LOG_ID,
      {
        R2_GRANTS: r2,
        SUPPORTED_CHAINS_RPC: JSON.stringify({
          [CHAIN_ID]: ["http://127.0.0.1:8545"],
        }),
      },
    );

    expect(result instanceof Response).toBe(false);
  });

  it("rejects mismatched counterfactual address", async () => {
    const padded = toPaddedWire32(logIdToWireBytes(LOG_ID));
    const body = new Map<number, unknown>([
      [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
      [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_KS256],
      [
        FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
        deployerBytes("0x1528b86ff561f617602356efdbD05908a07AA788"),
      ],
      [FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID, padded],
      [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, proxyBytes("0x" + "11".repeat(20))],
      [FOREST_GENESIS_LABEL_CHAIN_ID, CHAIN_ID],
      [
        FOREST_GENESIS_LABEL_UNIVOCITY_VARIANT,
        FOREST_GENESIS_UNIVOCITY_VARIANT_UUPS_COUNTERFACTUAL,
      ],
      [FOREST_GENESIS_LABEL_UNIVOCITY_DEPLOYER, deployerBytes(vector.deployer)],
    ]);

    const result = await postForestGenesis(
      new Request("http://localhost/genesis", {
        method: "POST",
        headers: { "Content-Type": "application/cbor" },
        body: encodeCborDeterministic(body),
      }),
      LOG_ID,
      {
        R2_GRANTS: {} as R2Bucket,
        SUPPORTED_CHAINS_RPC: JSON.stringify({
          [CHAIN_ID]: ["http://127.0.0.1:8545"],
        }),
      },
    );

    expect(result instanceof Response).toBe(true);
    if (result instanceof Response) {
      expect(result.status).toBe(400);
    }
  });

  it("rejects when CREATE3 factory env differs from deployer prediction", async () => {
    const padded = toPaddedWire32(logIdToWireBytes(LOG_ID));
    const body = new Map<number, unknown>([
      [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
      [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_KS256],
      [
        FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
        deployerBytes("0x1528b86ff561f617602356efdbD05908a07AA788"),
      ],
      [FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID, padded],
      [
        FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
        proxyBytes(vector.expectedProxyAddress),
      ],
      [FOREST_GENESIS_LABEL_CHAIN_ID, CHAIN_ID],
      [
        FOREST_GENESIS_LABEL_UNIVOCITY_VARIANT,
        FOREST_GENESIS_UNIVOCITY_VARIANT_UUPS_COUNTERFACTUAL,
      ],
      [FOREST_GENESIS_LABEL_UNIVOCITY_DEPLOYER, deployerBytes(vector.deployer)],
    ]);

    const result = await postForestGenesis(
      new Request("http://localhost/genesis", {
        method: "POST",
        headers: { "Content-Type": "application/cbor" },
        body: encodeCborDeterministic(body),
      }),
      LOG_ID,
      {
        R2_GRANTS: {} as R2Bucket,
        SUPPORTED_CHAINS_RPC: JSON.stringify({
          [CHAIN_ID]: ["http://127.0.0.1:8545"],
        }),
        CREATE3_FACTORY_ADDRESS: "0x0000000000000000000000000000000000000001",
      },
    );

    expect(result instanceof Response).toBe(true);
    if (result instanceof Response) {
      expect(result.status).toBe(400);
    }
  });
});
