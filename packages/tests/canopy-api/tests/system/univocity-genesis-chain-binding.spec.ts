import { expectAPI as expect, test } from "@e2e-fixtures/auth";
import { bytesEqual } from "@e2e-canopy-api-src/cbor-api/cbor-map-utils.js";
import {
  logIdToWireBytes,
  toPaddedWire32,
} from "@e2e-canopy-api-src/grant/log-id-wire.js";
import { publicKeyPemToUncompressed65 } from "@e2e-canopy-api-src/scrapi/custodian-grant.js";
import { assertBootstrapMintE2eEnv } from "@e2e-utils/e2e-env-guards";
import {
  custodianCustodySignEnv,
  custodianKmsCryptoKeyIdFromLogUuid,
  postCustodianEnsureEs256Key,
} from "@e2e-utils/custodian-custody-grant";
import { ensureForestGenesisE2e } from "@e2e-utils/forest-genesis-e2e";
import { mintBootstrapGrant } from "@e2e-utils/bootstrap-grant-flow";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
  responseTextPreview,
} from "@e2e-utils/problem-details";
import { e2eStaticCustodianKeyLabels } from "@e2e-utils/e2e-static-log-ids";
import {
  es256ChainBindingSkipReason,
  getForestGenesisParsed,
  univocityContractAddrBytes,
  univocityGenesisChainId,
  univocityGenesisLogId,
} from "@e2e-utils/univocity-genesis-e2e";

/**
 * Forest genesis with **real Base Sepolia chain binding** (plan-0007 scenario).
 *
 * Uses a **fixed** root log id so the genesis persists across runs: the first
 * run creates it (201, "genesis exists before first checkpoint"); later runs see
 * it already present (409). Reset with `task cf:genesis:delete LOG_ID=<R>`.
 *
 * Phase 1 (this spec) covers the genesis lifecycle only: POST (201/409) + GET
 * verify of chain-id / univocity-addr / bootstrap-logid / COSE key. The bootstrap
 * register-grant 303 flow is Phase 2 (needs per-log MMR reset to re-run).
 *
 * Requires: `CURATOR_ADMIN_TOKEN`, `CUSTODIAN_URL`, `CUSTODIAN_APP_TOKEN`, and a
 * Univocity deployment whose on-chain `bootstrapConfig()` is **ES256** (64-byte
 * x‖y). The default Base Sepolia Safe deployment is KS256 and is skipped.
 */
test.describe("Univocity genesis chain binding (Base Sepolia)", () => {
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
    const custody = custodianCustodySignEnv()!;

    const rootLogId = univocityGenesisLogId();
    const chainId = univocityGenesisChainId();
    const univocityAddr = univocityContractAddrBytes();

    // Stable keypair for the fixed R: Custodian key id is deterministic from the
    // log id, so the genesis pubkey keeps matching across runs.
    const { publicKeyPem } = await postCustodianEnsureEs256Key({
      baseUrl: custody.baseUrl,
      appToken: custody.token,
      keyOwnerId: custodianKmsCryptoKeyIdFromLogUuid(rootLogId),
      selfLogId: rootLogId,
      labels: e2eStaticCustodianKeyLabels(),
    });
    const uncompressed = publicKeyPemToUncompressed65(publicKeyPem);
    const x = uncompressed.subarray(1, 33);
    const y = uncompressed.subarray(33, 65);

    // First run creates (201); later runs already present (409). Both pass.
    await ensureForestGenesisE2e(unauthorizedRequest, {
      logId: rootLogId,
      curatorToken,
      x,
      y,
      univocityAddr,
      chainId,
    });

    const parsed = await getForestGenesisParsed(unauthorizedRequest, rootLogId);

    expect(parsed.chainId, "stored chain-id is Base Sepolia").toBe(chainId);
    expect(
      bytesEqual(parsed.univocityAddr, univocityAddr),
      "stored univocity-addr matches contract under test",
    ).toBe(true);
    expect(
      parsed.univocityAddr.length,
      "univocity-addr is a 20-byte address",
    ).toBe(20);
    expect(
      bytesEqual(
        parsed.bootstrapLogId,
        toPaddedWire32(logIdToWireBytes(rootLogId)),
      ),
      "stored bootstrap-logid equals padded wire(R)",
    ).toBe(true);
    expect(parsed.x!.length, "COSE x is 32 bytes").toBe(32);
    expect(parsed.y!.length, "COSE y is 32 bytes").toBe(32);
    expect(bytesEqual(parsed.x!, x), "COSE x matches genesis key").toBe(true);
    expect(bytesEqual(parsed.y!, y), "COSE y matches genesis key").toBe(true);
  });

  test("ensureForestGenesis is idempotent (re-POST tolerated, GET unchanged)", async ({
    unauthorizedRequest,
  }) => {
    assertBootstrapMintE2eEnv();
    const curatorToken = process.env.CURATOR_ADMIN_TOKEN!.trim();
    const custody = custodianCustodySignEnv()!;

    const rootLogId = univocityGenesisLogId();
    const chainId = univocityGenesisChainId();
    const univocityAddr = univocityContractAddrBytes();

    const { publicKeyPem } = await postCustodianEnsureEs256Key({
      baseUrl: custody.baseUrl,
      appToken: custody.token,
      keyOwnerId: custodianKmsCryptoKeyIdFromLogUuid(rootLogId),
      selfLogId: rootLogId,
      labels: e2eStaticCustodianKeyLabels(),
    });
    const uncompressed = publicKeyPemToUncompressed65(publicKeyPem);
    const x = uncompressed.subarray(1, 33);
    const y = uncompressed.subarray(33, 65);

    await ensureForestGenesisE2e(unauthorizedRequest, {
      logId: rootLogId,
      curatorToken,
      x,
      y,
      univocityAddr,
      chainId,
    });

    const parsed = await getForestGenesisParsed(unauthorizedRequest, rootLogId);
    expect(parsed.chainId).toBe(chainId);
    expect(bytesEqual(parsed.univocityAddr, univocityAddr)).toBe(true);
  });

  // Phase 2: cold-bootstrap register-grant with the real chain binding.
  //
  // Only returns 303 while R is **MMRS-cold** (no first massif tile). Because R
  // is fixed, re-running after the first success requires the two-task reset:
  //   task cf:genesis:delete LOG_ID=<R> && task cf:mmr:delete LOG_ID=<R>
  test("cold-bootstrap register-grant on R returns 303 with real-binding genesis", async ({
    unauthorizedRequest,
  }, testInfo) => {
    assertBootstrapMintE2eEnv();
    const rootLogId = univocityGenesisLogId();
    const chainId = univocityGenesisChainId();
    const univocityAddr = univocityContractAddrBytes();
    const baseURL = testInfo.project.use.baseURL ?? "";

    const { grantBase64 } = await mintBootstrapGrant(
      unauthorizedRequest,
      rootLogId,
      { univocityAddr, chainId },
    );

    const registerRes = await unauthorizedRequest.post(
      `/register/${rootLogId}/grants`,
      {
        headers: { Authorization: `Forestrie-Grant ${grantBase64}` },
        maxRedirects: 0,
      },
    );

    const problem = await reportProblemDetails(registerRes, testInfo);
    const status = registerRes.status();
    let hint = formatProblemDetailsMessage(problem) ?? "register-grant";
    if (status !== 303) {
      hint += `\nBody preview: ${await responseTextPreview(registerRes)}`;
      hint +=
        "\nExpected 303 on the cold-bootstrap branch. A non-303 usually means R " +
        "is already MMRS-warm from a prior run; reset with " +
        "`task cf:genesis:delete LOG_ID=<R> && task cf:mmr:delete LOG_ID=<R>`.";
    }
    expect(status, hint).toBe(303);

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
  });
});
