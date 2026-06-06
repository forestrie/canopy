import { expectAPI as expect, test } from "@e2e-fixtures/auth";
import { bytesEqual } from "@e2e-canopy-api-src/cbor-api/cbor-map-utils.js";
import {
  logIdToWireBytes,
  toPaddedWire32,
} from "@e2e-canopy-api-src/grant/log-id-wire.js";
import { assertBootstrapMintE2eEnv } from "@e2e-utils/e2e-env-guards";
import { ensureForestGenesisKs256E2e } from "@e2e-utils/forest-genesis-e2e";
import {
  COSE_ALG_KS256,
  DEFAULT_UNIVOCITY_KS256_SAFE_ADDR,
  fetchOnChainBootstrapConfig,
  getForestGenesisParsed,
  ks256BootstrapContractAddr,
  ks256BootstrapContractAddrBytes,
  ks256ChainBindingSkipReason,
  ks256GenesisLogId,
  univocityGenesisChainId,
} from "@e2e-utils/univocity-genesis-e2e";

/**
 * Forest genesis with KS256 bootstrap (default Base Sepolia Safe deployment).
 *
 * Uses genesis v2 (genesisAlg -65799 + 20-byte Safe address).
 */
test.describe("Univocity KS256 genesis chain binding (Base Sepolia)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const skip = await ks256ChainBindingSkipReason();
    if (skip) {
      test.skip(true, skip);
    }
  });

  test("KS256 genesis anchors to on-chain bootstrapConfig", async ({
    unauthorizedRequest,
  }) => {
    assertBootstrapMintE2eEnv();
    const curatorToken = process.env.CURATOR_ADMIN_TOKEN!.trim();

    const rootLogId = ks256GenesisLogId();
    const chainId = univocityGenesisChainId();
    const univocityAddr = ks256BootstrapContractAddrBytes();

    const boot = await fetchOnChainBootstrapConfig(ks256BootstrapContractAddr());
    expect(boot.alg).toBe(COSE_ALG_KS256);
    expect(boot.key.length).toBe(20);

    await ensureForestGenesisKs256E2e(unauthorizedRequest, {
      logId: rootLogId,
      curatorToken,
      ks256Address: boot.key,
      univocityAddr,
      chainId,
    });

    const parsed = await getForestGenesisParsed(unauthorizedRequest, rootLogId);
    expect(parsed.chainId).toBe(chainId);
    expect(bytesEqual(parsed.univocityAddr, univocityAddr)).toBe(true);
    expect(
      bytesEqual(
        parsed.bootstrapLogId,
        toPaddedWire32(logIdToWireBytes(rootLogId)),
      ),
    ).toBe(true);
    expect(parsed.bootstrapAlg).toBe(COSE_ALG_KS256);
    expect(parsed.bootstrapKey?.length).toBe(20);
    expect(bytesEqual(parsed.bootstrapKey!, boot.key)).toBe(true);

    const expectedSafe =
      DEFAULT_UNIVOCITY_KS256_SAFE_ADDR.toLowerCase().replace(/^0x/, "");
    const actualHex = Buffer.from(parsed.bootstrapKey!).toString("hex");
    expect(actualHex).toBe(expectedSafe);
  });
});
