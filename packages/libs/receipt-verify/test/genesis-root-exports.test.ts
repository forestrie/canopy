import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// Deliberately the package ROOT entry, not a deep `../src/*.js` import: this
// is the assertion that `FOREST_GENESIS_LABEL_*`, `decodeTrustRootFromGenesis`
// and `decodeChainBindingFromGenesis` all resolve through `"."` in
// `package.json#exports` (plan-2609-07 L3), the gap mcp-resolve's own
// `genesis-binding.ts` comment documents against 1.0.0.
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_LOG_ID,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  decodeChainBindingFromGenesis,
  decodeTrustRootFromGenesis,
} from "../src/index.js";

const LANE_A_GENESIS_SHA256 =
  "c6183184d805bf23652a265d7f533101eec5c97e1939dd90c7f142e6d502da68";
const LANE_A_BOOTSTRAP_KEY_XY_HEX =
  "4284403053a157bf6976be27e0c0bdf746da8d9d4269a211b99505b0f977ae1" +
  "e2856fb3b2b009ac46403328bc3ea6869b13459bbbacfb1dc545f9f782712486c";

describe("FOREST_GENESIS_LABEL_* root export", () => {
  it("resolves every label constant from the package root", () => {
    expect(FOREST_GENESIS_LABEL_GENESIS_VERSION).toBe(-68009);
    expect(FOREST_GENESIS_LABEL_LOG_ID).toBe(-68010);
    expect(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR).toBe(-68011);
    expect(FOREST_GENESIS_LABEL_CHAIN_ID).toBe(-68013);
    expect(FOREST_GENESIS_LABEL_GENESIS_ALG).toBe(-68014);
    expect(FOREST_GENESIS_LABEL_BOOTSTRAP_KEY).toBe(-68015);
  });
});

describe("lane-a genesis fixture (plan-2609-05/07)", () => {
  const genesisPath = new URL(
    "./fixtures/lane-a/genesis.cbor",
    import.meta.url,
  );
  const genesis = new Uint8Array(readFileSync(genesisPath));

  it("is the frozen 160-byte fixture the plan names", async () => {
    expect(genesis.length).toBe(160);
    const sha256 = Buffer.from(
      await crypto.subtle.digest("SHA-256", genesis as unknown as BufferSource),
    ).toString("hex");
    expect(sha256).toBe(LANE_A_GENESIS_SHA256);
    expect(sha256.startsWith("c6183184")).toBe(true);
    expect(sha256.endsWith("02da68")).toBe(true);
  });

  it("decodeTrustRootFromGenesis (imported from the package root) returns bootstrapKeyXy alongside the CryptoKey", async () => {
    const { key, bootstrapKeyXy } = await decodeTrustRootFromGenesis(genesis);

    expect(bootstrapKeyXy).toBeInstanceOf(Uint8Array);
    expect(bootstrapKeyXy.length).toBe(64);
    expect(Buffer.from(bootstrapKeyXy).toString("hex")).toBe(
      LANE_A_BOOTSTRAP_KEY_XY_HEX,
    );

    // The non-extractable CryptoKey is unchanged: still a P-256 ECDSA
    // public key usable for `crypto.subtle.verify`.
    expect(key).toBeInstanceOf(CryptoKey);
    const cryptoKey = key as CryptoKey;
    expect(cryptoKey.type).toBe("public");
    expect(cryptoKey.extractable).toBe(false);
    expect(cryptoKey.usages).toContain("verify");
    expect((cryptoKey.algorithm as EcKeyAlgorithm).name).toBe("ECDSA");
    expect((cryptoKey.algorithm as EcKeyAlgorithm).namedCurve).toBe("P-256");
  });

  it("decodeChainBindingFromGenesis (imported from the package root) decodes the univocity/chainId/logId binding", () => {
    const binding = decodeChainBindingFromGenesis(genesis);
    expect(binding.univocity).toBe(
      "0x678768643b4667aedcb313cc81624aa560b7f0ca",
    );
    expect(binding.chainId).toBe(84532);
    expect(binding.logId).toBeInstanceOf(Uint8Array);
    expect(binding.logId.length).toBe(32);
  });
});
