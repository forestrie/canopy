import { expectAPI as expect, test } from "@e2e-fixtures/auth";
import { bytesEqual } from "@e2e-canopy-api-src/cbor-api/cbor-map-utils.js";
import {
  logIdToWireBytes,
  toPaddedWire32,
} from "@e2e-canopy-api-src/grant/log-id-wire.js";
import { assertBootstrapMintE2eEnv } from "@e2e-utils/e2e-env-guards";
import { ensureForestGenesisEs256E2e } from "@e2e-utils/forest-genesis-e2e";
import {
  bootstrapEs256PrivateKeyPem,
  mintEs256RootGrantWithBootstrapPem,
} from "@e2e-utils/mint-es256-root-grant-e2e";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
  responseTextPreview,
} from "@e2e-utils/problem-details";
import {
  COSE_ALG_ES256,
  es256BootstrapContractAddr,
  es256BootstrapContractAddrBytes,
  es256ChainBindingSkipReason,
  es256GenesisLogId,
  fetchOnChainBootstrapConfig,
  getForestGenesisParsed,
  univocityGenesisChainId,
} from "@e2e-utils/univocity-genesis-e2e";

/**
 * Forest genesis with **real Base Sepolia chain binding** (ES256 ImutableUnivocity).
 *
 * Uses genesis v2 (genesisAlg -7 + 64-byte bootstrapKey from on-chain
 * `bootstrapConfig()`). Register-grant mints a separate Custodian ES256 key.
 */
test.describe("Univocity ES256 genesis chain binding (Base Sepolia)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const skip = await es256ChainBindingSkipReason();
    if (skip) {
      test.skip(true, skip);
    }
  });

  test("genesis is created/present with real chain binding and verifies via GET", async ({
    unauthorizedRequest,
  }) => {
    assertBootstrapMintE2eEnv();
    const curatorToken = process.env.CURATOR_ADMIN_TOKEN!.trim();

    const rootLogId = es256GenesisLogId();
    const chainId = univocityGenesisChainId();
    const univocityAddr = es256BootstrapContractAddrBytes();
    const boot = await fetchOnChainBootstrapConfig(es256BootstrapContractAddr());

    expect(boot.alg).toBe(COSE_ALG_ES256);
    expect(boot.key.length).toBe(64);

    await ensureForestGenesisEs256E2e(unauthorizedRequest, {
      logId: rootLogId,
      curatorToken,
      bootstrapKey: boot.key,
      univocityAddr,
      chainId,
    });

    const parsed = await getForestGenesisParsed(unauthorizedRequest, rootLogId);

    expect(parsed.chainId, "stored chain-id is Base Sepolia").toBe(chainId);
    expect(
      bytesEqual(parsed.univocityAddr, univocityAddr),
      "stored univocity-addr matches contract under test",
    ).toBe(true);
    expect(parsed.bootstrapAlg).toBe(COSE_ALG_ES256);
    expect(parsed.bootstrapKey?.length).toBe(64);
    expect(bytesEqual(parsed.bootstrapKey!, boot.key)).toBe(true);
    expect(
      bytesEqual(
        parsed.bootstrapLogId,
        toPaddedWire32(logIdToWireBytes(rootLogId)),
      ),
      "stored bootstrap-logid equals padded wire(R)",
    ).toBe(true);
  });

  test("ensureForestGenesis is idempotent (re-POST tolerated, GET unchanged)", async ({
    unauthorizedRequest,
  }) => {
    assertBootstrapMintE2eEnv();
    const curatorToken = process.env.CURATOR_ADMIN_TOKEN!.trim();

    const rootLogId = es256GenesisLogId();
    const chainId = univocityGenesisChainId();
    const univocityAddr = es256BootstrapContractAddrBytes();
    const boot = await fetchOnChainBootstrapConfig(es256BootstrapContractAddr());

    await ensureForestGenesisEs256E2e(unauthorizedRequest, {
      logId: rootLogId,
      curatorToken,
      bootstrapKey: boot.key,
      univocityAddr,
      chainId,
    });

    const parsed = await getForestGenesisParsed(unauthorizedRequest, rootLogId);
    expect(parsed.chainId).toBe(chainId);
    expect(bytesEqual(parsed.univocityAddr, univocityAddr)).toBe(true);
  });

  // Root creation grant signed by the contract's on-chain ES256 bootstrap key
  // (BOOTSTRAP_PEM_ES256), so grantData == bootstrapConfig() and the envelope
  // verifies against the real chain anchor. Single canonical R, so we probe:
  // 303 when R is MMRS-cold (cold bootstrap exercised end-to-end), or confirm
  // the established root when R is already MMRS-warm from a prior run.
  test("register-grant on R returns 303 when cold, else confirms established root", async ({
    unauthorizedRequest,
  }, testInfo) => {
    const pem = bootstrapEs256PrivateKeyPem();
    test.skip(
      !pem,
      "BOOTSTRAP_PEM_ES256 not set; cannot sign the on-chain root creation grant",
    );
    assertBootstrapMintE2eEnv();
    const curatorToken = process.env.CURATOR_ADMIN_TOKEN!.trim();
    const rootLogId = es256GenesisLogId();
    const chainId = univocityGenesisChainId();
    const univocityAddr = es256BootstrapContractAddrBytes();
    const baseURL = testInfo.project.use.baseURL ?? "";
    const boot = await fetchOnChainBootstrapConfig(es256BootstrapContractAddr());

    expect(boot.alg).toBe(COSE_ALG_ES256);
    expect(boot.key.length).toBe(64);

    await ensureForestGenesisEs256E2e(unauthorizedRequest, {
      logId: rootLogId,
      curatorToken,
      bootstrapKey: boot.key,
      univocityAddr,
      chainId,
    });

    const { grantBase64 } = mintEs256RootGrantWithBootstrapPem({
      rootLogId,
      bootstrapKey64: boot.key,
      es256PrivateKeyPem: pem!,
    });

    const registerRes = await unauthorizedRequest.post(
      `/register/${rootLogId}/grants`,
      {
        headers: { Authorization: `Forestrie-Grant ${grantBase64}` },
        maxRedirects: 0,
      },
    );

    const problem = await reportProblemDetails(registerRes, testInfo);
    const status = registerRes.status();

    if (status === 303) {
      testInfo.annotations.push({
        type: "branch",
        description: "cold bootstrap: register-grant 303 redirect",
      });
      const location = registerRes.headers().location;
      expect(location, "303 must include Location").toBeTruthy();
      let absolute = location!;
      if (!absolute.startsWith("http")) {
        absolute = `${baseURL}${absolute.startsWith("/") ? "" : "/"}${absolute}`;
      }
      const escaped = rootLogId.replace(/-/g, "\\-");
      expect(absolute).toMatch(
        new RegExp(`/logs/${escaped}/${escaped}/entries/[0-9a-f]{64}$`, "i"),
      );
      return;
    }

    // Non-303: the only acceptable outcome is a steady-state (MMRS-warm) refusal,
    // where a bare creation grant is rejected for lacking an inclusion receipt.
    // We do not reset the canonical R (single root per contract instance); instead
    // confirm the established root binding is unchanged. Any other failure — a
    // creation-grant signature/chain rejection (403 "grant envelope not signed"),
    // conflict, or 503 — is a real bug and must fail the test rather than be
    // silently treated as "warm".
    const detail = problem?.detail ?? "";
    const bodyText = await responseTextPreview(registerRes);
    const hint = formatProblemDetailsMessage(problem) ?? bodyText;
    const warmReceiptRequired =
      /unprotected header 396|inclusion is required/i.test(detail) ||
      /unprotected header 396|inclusion is required/i.test(bodyText);
    expect(
      warmReceiptRequired,
      `register-grant returned ${status}, which is neither a 303 (cold bootstrap) ` +
        `nor the steady-state receipt-required refusal (warm R). This usually means ` +
        `the PEM-signed grant failed envelope/chain verification — a signing or ` +
        `chain-binding bug, not a warm log. ${hint}`,
    ).toBe(true);
    testInfo.annotations.push({
      type: "branch",
      description: `established root (MMRS-warm): register-grant returned ${status}`,
    });

    const parsed = await getForestGenesisParsed(unauthorizedRequest, rootLogId);
    expect(parsed.bootstrapAlg, hint).toBe(COSE_ALG_ES256);
    expect(parsed.bootstrapKey?.length).toBe(64);
    expect(
      bytesEqual(parsed.bootstrapKey!, boot.key),
      "warm R still bound to the on-chain ES256 bootstrap key",
    ).toBe(true);
  });
});
