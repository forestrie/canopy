import type { APIRequestContext } from "@playwright/test";
import type { Grant } from "@forestrie/grant-builder";
import {
  base64ToBytes,
  bytesToForestrieGrantBase64,
} from "@forestrie/grant-builder";
import {
  attachReceiptAndIdtimestampToTransparentStatement,
  entryIdHexToIdtimestampBe8,
} from "@forestrie/receipt-verify";
import {
  assertBootstrapMintE2eEnv,
  assertBootstrapReceiptE2eEnv,
} from "./e2e-env-guards.js";
import { mintOnboardTokenE2e } from "./onboard-token-e2e.js";
import type { E2eBootstrapVariant } from "./e2e-bootstrap-variant.js";
import { mintRootGrantForVariant } from "./mint-root-grant-e2e.js";
import {
  pollBootstrapRegistrationThroughReceipt,
  setupBootstrapCoordinatorDelegation,
  type BootstrapSigningContext,
} from "./bootstrap-delegation-coordinator.js";
import { assertCoordinatorApiE2eEnv } from "./coordinator-api-env.js";
import type { ByokPollStats } from "./byok-wallet-seal-helpers.js";
import { postRegisterGrantExpect303 } from "./bootstrap-grant-setup.js";
import { sequencingBackoff } from "./arithmetic-backoff-poll.js";
import { normalizeForestrieHexId32 } from "./forestrie-hex-id.js";
import { signStandingAdvanceDelegation } from "./sign-standing-advance-delegation.js";

/**
 * Deterministic grant assembly + shape assertions moved to
 * @forestrie/grant-builder (plan-2607-12 Phase 2, FOR-350); re-exported here
 * for compatibility.
 */
export {
  assertCustodianProfileTransparentStatement,
  assertRootGrantTransparentStatement,
  base64ToBytes,
  bytesToForestrieGrantBase64,
} from "@forestrie/grant-builder";

/**
 * Root bootstrap mint: ephemeral Imutable chain binding + contract-bootstrap-signed
 * root creation grant. Requires onboard token and Univocity provision env.
 */
export async function mintBootstrapGrant(
  unauthorizedRequest: APIRequestContext,
  rootLogId: string,
  variant: E2eBootstrapVariant,
): Promise<{ grantBase64: string }> {
  assertBootstrapMintE2eEnv();
  const onboardToken = await mintOnboardTokenE2e(
    unauthorizedRequest,
    { chainId: variant.chainId, univocityAddr: variant.contractAddrBytes },
    `bootstrap-${rootLogId.slice(0, 8)}`,
  );
  const { grantBase64 } = await mintRootGrantForVariant(
    unauthorizedRequest,
    rootLogId,
    variant,
    onboardToken,
  );
  return { grantBase64 };
}

/** Sign a child (or other) grant with the owner root key for this variant. */
export function signChildGrantUnderRoot(
  variant: E2eBootstrapVariant,
  grant: Grant,
): string {
  return variant.signOwnerGrant(grant);
}

export interface CompleteBootstrapGrantWithReceiptOptions {
  unauthorizedRequest: APIRequestContext;
  logId: string;
  baseURL: string;
  grantBase64: string;
  variant: E2eBootstrapVariant;
  ladderMs?: number[];
  pollRegistrationMaxMs?: number;
  resolveReceiptMaxMs?: number;
}

export interface CompleteBootstrapGrantWithReceiptResult {
  statusUrlAbsolute: string;
  receiptUrlAbsolute: string;
  entryIdHex: string;
  grantBase64: string;
  receiptRes: {
    status: number;
    headers: { [key: string]: string };
    body: Uint8Array;
  };
}

/**
 * POST register-grant, poll until receipt redirect (with coordinator delegation
 * material loop), GET receipt until 200.
 */
/**
 * Cover the standing sealer key, retrying while the coordinator is still
 * registering it.
 *
 * Fails LOUDLY when it never appears. An uncovered standing key does not error
 * anywhere — it just makes checkpointing defer forever, which surfaces minutes
 * later as a receipt 404 that reads like a product defect.
 */
async function establishStandingDelegation(opts: {
  request: APIRequestContext;
  logId: string;
  signingContext: BootstrapSigningContext;
}): Promise<void> {
  const coordinator = assertCoordinatorApiE2eEnv();
  const logIdHex32 = normalizeForestrieHexId32(opts.logId);
  const attempts = 10;
  let lastReason = "not attempted";

  for (let attempt = 0; attempt < attempts; attempt++) {
    const outcome = await signStandingAdvanceDelegation({
      request: opts.request,
      coordinatorUrl: coordinator.baseUrl,
      coordinatorToken: coordinator.appToken,
      logId: opts.logId,
      logIdHex32,
      signingContext: opts.signingContext,
    });
    if (outcome.signed) {
      return;
    }
    lastReason = outcome.reason;
    await new Promise((r) => setTimeout(r, 1_000));
  }

  throw new Error(
    `log ${opts.logId}: standing delegate-key entry never appeared after ` +
      `${attempts} attempts (${lastReason}). Until it is signed the sealer ` +
      `defers on "delegation material pending" and the receipt 404s — check ` +
      `that a public root and a sealer delegate key are registered (C1/C3).`,
  );
}

export async function completeBootstrapGrantWithReceipt(
  opts: CompleteBootstrapGrantWithReceiptOptions,
): Promise<CompleteBootstrapGrantWithReceiptResult> {
  assertBootstrapReceiptE2eEnv();
  const signingContext = await setupBootstrapCoordinatorDelegation({
    request: opts.unauthorizedRequest,
    logId: opts.logId,
    variant: opts.variant,
  });

  // Delegate to the STANDING sealer key over [0, horizon] before registering.
  // Without it the sealer's coverage lookup finds nothing covering its true seal
  // window and defers on "delegation material pending" — the receipt then 404s
  // to the deadline (ADR-0050 C3; FOR-531).
  //
  // Retried because the coordinator registers the standing key asynchronously,
  // so the first look can legitimately be empty. Failing to cover it is fatal:
  // that silence is exactly what cost two days of intermittent lane failures.
  await establishStandingDelegation({
    request: opts.unauthorizedRequest,
    logId: opts.logId,
    signingContext,
  });
  const signedMaterialKeys = new Set<string>();
  const stats: ByokPollStats = {
    pendingEntriesSeen: 0,
    materialSigned: 0,
  };

  const { statusUrlAbsolute } = await postRegisterGrantExpect303(
    opts.unauthorizedRequest,
    {
      bootstrapLogId: opts.logId,
      baseURL: opts.baseURL,
      grantBase64: opts.grantBase64,
    },
  );

  const ladder = opts.ladderMs ?? sequencingBackoff;
  const { receiptUrlAbsolute, entryIdHex, receiptRes } =
    await pollBootstrapRegistrationThroughReceipt({
      request: opts.unauthorizedRequest,
      statusUrlAbsolute,
      baseURL: opts.baseURL,
      logId: opts.logId,
      signingContext,
      signedMaterialKeys,
      stats,
      ladderMs: ladder,
      maxWaitMs: opts.pollRegistrationMaxMs,
      resolveReceiptMaxMs: opts.resolveReceiptMaxMs,
    });

  return {
    statusUrlAbsolute,
    receiptUrlAbsolute,
    entryIdHex,
    grantBase64: opts.grantBase64,
    receiptRes,
  };
}

export function buildCompletedGrantBase64(
  grantBase64: string,
  receiptBytes: Uint8Array,
  entryIdHex: string,
): string {
  const grantBytes = base64ToBytes(grantBase64);
  const idtimestampBe8 = entryIdHexToIdtimestampBe8(entryIdHex);
  const completedBytes = attachReceiptAndIdtimestampToTransparentStatement(
    grantBytes,
    receiptBytes,
    idtimestampBe8,
  );
  return bytesToForestrieGrantBase64(completedBytes);
}
