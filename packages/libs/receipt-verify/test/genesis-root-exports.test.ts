import { readFileSync } from "node:fs";
import { encodeCborDeterministic } from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
// Deliberately the package ROOT entry, not a deep `../src/*.js` import: this
// is the assertion that `FOREST_GENESIS_LABEL_*`, `decodeTrustRootFromGenesis`,
// `decodeTrustRootDetailsFromGenesis` and `decodeChainBindingFromGenesis` all
// resolve through `"."` in `package.json#exports` (plan-2609-07 L3), the gap
// mcp-resolve's own `genesis-binding.ts` comment documents against 1.0.0.
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_LOG_ID,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  decodeChainBindingFromGenesis,
  decodeTrustRootDetailsFromGenesis,
  decodeTrustRootFromGenesis,
} from "../src/index.js";
import { COSE_ALG_KS256 } from "../src/cose-key.js";
import { FOREST_GENESIS_SCHEMA_V2 } from "../src/forest-genesis-labels.js";

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

  it("decodeTrustRootFromGenesis (imported from the package root) keeps its origin/main signature: a bare CryptoKey, not a details object", async () => {
    const key = await decodeTrustRootFromGenesis(genesis);

    // The non-extractable CryptoKey, returned directly — this is what
    // mcp-verify 1.0.0-pinned code (verify-receipt.ts, verify-grant-receipt.ts)
    // uses as the verify key, so the return shape here must stay a bare
    // `RootVerifyKey`, not `{ key, bootstrapKeyXy }`.
    expect(key).toBeInstanceOf(CryptoKey);
    const cryptoKey = key as CryptoKey;
    expect(cryptoKey.type).toBe("public");
    expect(cryptoKey.extractable).toBe(false);
    expect(cryptoKey.usages).toContain("verify");
    expect((cryptoKey.algorithm as EcKeyAlgorithm).name).toBe("ECDSA");
    expect((cryptoKey.algorithm as EcKeyAlgorithm).namedCurve).toBe("P-256");
  });

  it("decodeTrustRootDetailsFromGenesis (imported from the package root) returns bootstrapKeyXy alongside the same CryptoKey", async () => {
    const { key, bootstrapKeyXy } =
      await decodeTrustRootDetailsFromGenesis(genesis);

    expect(bootstrapKeyXy).toBeInstanceOf(Uint8Array);
    expect(bootstrapKeyXy!.length).toBe(64);
    expect(Buffer.from(bootstrapKeyXy!).toString("hex")).toBe(
      LANE_A_BOOTSTRAP_KEY_XY_HEX,
    );

    // Same non-extractable CryptoKey decodeTrustRootFromGenesis returns.
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

// No KS256 v2 genesis FIXTURE exists anywhere in this package's test suite
// (test/ and src/ reference KS256 only in src/cose-key.ts,
// src/decode-trust-root-cbor.ts, src/resolve-delegated-verify-key.ts and
// src/root-verify-key.ts — no captured or built fixture file carries a
// KS256 bootstrap key). Per plan-2609-07 L3 rework instructions, that case
// is reported here rather than fabricating a fixture; the KS256 branch of
// decodeTrustRootDetailsFromGenesis is instead exercised below with a
// hand-built minimal v2 genesis map (same technique test/negatives.test.ts
// and test/decode-chain-binding-from-genesis.test.ts already use for their
// own negative-path cases), not a recorded/frozen fixture.
describe("decodeTrustRootDetailsFromGenesis KS256 v2 bootstrap key", () => {
  it("returns bootstrapKeyXy === undefined without throwing", async () => {
    const ks256Address = new Uint8Array(20).fill(0x11);
    const genesis = encodeCborDeterministic(
      new Map<number, unknown>([
        [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
        [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_KS256],
        [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, ks256Address],
      ]),
    );

    const { key, bootstrapKeyXy } =
      await decodeTrustRootDetailsFromGenesis(genesis);

    expect(bootstrapKeyXy).toBeUndefined();
    expect(key).not.toBeInstanceOf(CryptoKey);
    expect((key as { kind: string }).kind).toBe("KS256");

    // decodeTrustRootFromGenesis (the origin/main-shaped function) resolves
    // the same KS256 root key without throwing — this is the origin/main
    // behaviour the rework restores.
    const bareKey = await decodeTrustRootFromGenesis(genesis);
    expect(bareKey).toEqual(key);
  });
});
