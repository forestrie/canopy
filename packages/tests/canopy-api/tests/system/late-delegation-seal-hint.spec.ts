/**
 * Late-delegation seal-hint e2e: a certificate submitted AFTER the sealer has
 * already asked (and parked a pending row) must produce the sealed receipt
 * promptly — the coordinator's certificate handler publishes a seal hint that
 * wakes the deferring sealer (delegation-coordinator src/seal-hint.ts),
 * instead of leaving the retry to queue redelivery or the resync sweep.
 *
 * This is the wallet-signed BYOK ordering as real clients hit it: the entry
 * registers and sequences first, the sealer's reactive attempt finds no
 * certificate and defers (`ErrDelegationPending`), and only then does the key
 * owner sign. Before the hint, that ordering cost a sealer retry cadence
 * (minutes); with it, seconds.
 *
 * Split from byok-checkpoint-seal.spec.ts (which signs pending material as
 * soon as it appears, interleaved with polling) because the assertion here is
 * the LATENCY between certificate submission and receipt: the test first
 * waits for the parked pending row WITHOUT signing, then signs, then times
 * the receipt.
 *
 * Opt-in: E2E_SEAL_HINT_LATENCY=1 — requires a lane whose coordinator has
 * SEAL_HINT_QUEUE_URL configured (else the budget assertion measures the old
 * slow path and fails). Budget override: E2E_SEAL_HINT_BUDGET_MS.
 */

import { randomUUID } from "node:crypto";
import { expectAPI as expect, test } from "@e2e-fixtures/auth";
import {
  assertCoordinatorApiE2eEnv,
  coordinatorAppToken,
  delegationCoordinatorBaseUrl,
} from "@e2e-utils/coordinator-api-env";
import {
  exportEs256RootXy,
  fetchLogPendingDelegation,
  generateEs256RootKeyPair,
  importEs256PemKeyPair,
  uploadByokRootPublicKey,
} from "@e2e-utils/coordinator-delegation-helpers";
import { bootstrapEs256PrivateKeyPem } from "@e2e-utils/mint-es256-root-grant-e2e";
import {
  exchangeEs256ControlPlaneSession,
  postSigningRouteWithSession,
  WALLET_CHALLENGE_ES256_SCOPES,
} from "@e2e-utils/wallet-challenge-session-e2e";
import { normalizeForestrieHexId32 } from "@e2e-utils/forestrie-hex-id";
import {
  mintByokBootstrapGrant,
  pollRegistrationThroughByokReceipt,
  signPendingDelegations,
} from "@e2e-utils/byok-wallet-seal-helpers";
import { sleepMs } from "@e2e-utils/arithmetic-backoff-poll";
import { postRegisterGrantExpect303 } from "@e2e-utils/bootstrap-grant-setup";
import { mintOnboardTokenE2e } from "@e2e-utils/onboard-token-e2e";
import {
  es256BootstrapContractAddrBytes,
  univocityGenesisChainId,
} from "@forestrie/canopy-e2e-kit";
import { modeCWebhookSealSkipReason } from "@e2e-utils/mode-c-e2e-env";

/** How long the certificate → receipt leg may take with the hint live. */
const SEAL_HINT_BUDGET_MS = Number.parseInt(
  process.env.E2E_SEAL_HINT_BUDGET_MS ?? "90000",
  10,
);
/** How long we allow the sealer to first ask and park (register → pending). */
const PENDING_APPEAR_BUDGET_MS = 180_000;

const skip = (() => {
  if (process.env.E2E_SEAL_HINT_LATENCY?.trim() !== "1") {
    return (
      "late-delegation seal-hint e2e requires E2E_SEAL_HINT_LATENCY=1 " +
      "(the coordinator lane must have SEAL_HINT_QUEUE_URL configured)."
    );
  }
  return modeCWebhookSealSkipReason();
})();

test.describe("late-delegation seal hint", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!!skip, skip ?? "");

  test("certificate submitted after the sealer parks still seals within budget", async ({
    unauthorizedRequest,
  }, testInfo) => {
    const coordinator = assertCoordinatorApiE2eEnv();
    const baseURL = testInfo.project.use.baseURL ?? "";
    const rootLogId = randomUUID();
    const rootLogHex32 = normalizeForestrieHexId32(rootLogId);
    // The root key MUST be the pinned bootstrap key: genesis chain-anchors
    // bootstrapKey to the contract's on-chain bootstrapConfig() (canopy#203),
    // so a freshly generated key can never register against the pinned
    // instance. Fresh keys remain fine where no pin exists (unit-style runs).
    const pinnedPem = bootstrapEs256PrivateKeyPem();
    const rootKeyPair = pinnedPem
      ? await importEs256PemKeyPair(pinnedPem)
      : await generateEs256RootKeyPair();

    const { x, y } = await exportEs256RootXy(rootKeyPair);
    const publicRoot = await uploadByokRootPublicKey({
      coordinatorUrl: coordinator.baseUrl,
      token: coordinator.appToken,
      logId: rootLogId,
      x,
      y,
    });
    expect(publicRoot.status).toBe(200);

    const session = await exchangeEs256ControlPlaneSession({
      request: unauthorizedRequest,
      coordinatorUrl: coordinator.baseUrl,
      authLogId: rootLogId,
      scopes: WALLET_CHALLENGE_ES256_SCOPES,
      rootKeyPair,
    });
    await postSigningRouteWithSession({
      request: unauthorizedRequest,
      coordinatorUrl: coordinator.baseUrl,
      logId: rootLogId,
      sessionToken: session.token,
      mode: "wallet",
    });

    const onboardToken = await mintOnboardTokenE2e(unauthorizedRequest, {
      chainId: univocityGenesisChainId(),
      univocityAddr: es256BootstrapContractAddrBytes(),
    });
    const { grantBase64 } = await mintByokBootstrapGrant({
      request: unauthorizedRequest,
      rootLogId,
      onboardToken,
      rootKeyPair,
    });
    const { statusUrlAbsolute } = await postRegisterGrantExpect303(
      unauthorizedRequest,
      { bootstrapLogId: rootLogId, baseURL, grantBase64 },
    );

    // Phase 1 — the late-delegation ordering: DO NOT sign anything. Wait for
    // the sealer's reactive attempt to find no certificate and park a
    // windowed pending row.
    const pendingStart = Date.now();
    let parked = 0;
    while (Date.now() - pendingStart < PENDING_APPEAR_BUDGET_MS) {
      const { entries } = await fetchLogPendingDelegation({
        request: unauthorizedRequest,
        coordinatorUrl: coordinator.baseUrl,
        logId: rootLogId,
      });
      parked = entries.filter(
        (e) => typeof e.mmrStart === "number" && typeof e.mmrEnd === "number",
      ).length;
      if (parked > 0) break;
      await sleepMs(3000);
    }
    expect(
      parked,
      `no windowed pending row within ${PENDING_APPEAR_BUDGET_MS}ms — sealer not parking`,
    ).toBeGreaterThan(0);

    // Phase 2 — the wallet signs NOW, minutes after the sealer asked.
    const signedMaterialKeys = new Set<string>();
    const stats = { pendingEntriesSeen: 0, materialSigned: 0 };
    const { signed } = await signPendingDelegations({
      request: unauthorizedRequest,
      coordinatorUrl: coordinator.baseUrl,
      coordinatorToken: coordinatorAppToken()!,
      logId: rootLogId,
      logIdHex32: rootLogHex32,
      rootKeyPair,
      signedMaterialKeys,
      stats,
    });
    expect(signed).toBeGreaterThan(0);
    const certSubmittedAt = Date.now();

    // Phase 3 — the receipt must arrive within the hint budget. The already-
    // populated signedMaterialKeys means the poll only re-signs if the sealer
    // parks NEW material (a wider window after growth), which is the same
    // late path again.
    const complete = await pollRegistrationThroughByokReceipt({
      request: unauthorizedRequest,
      statusUrlAbsolute,
      baseURL,
      coordinatorUrl: delegationCoordinatorBaseUrl()!,
      coordinatorToken: coordinatorAppToken()!,
      logId: rootLogId,
      logIdHex32: rootLogHex32,
      rootKeyPair,
      signedMaterialKeys,
      stats,
      maxWaitMs: SEAL_HINT_BUDGET_MS,
    });
    const elapsed = Date.now() - certSubmittedAt;
    expect(complete.receiptRes.status).toBe(200);
    expect(
      elapsed,
      `certificate → receipt took ${elapsed}ms; with seal hints live this must beat the sealer's retry cadence`,
    ).toBeLessThanOrEqual(SEAL_HINT_BUDGET_MS);
  });
});
