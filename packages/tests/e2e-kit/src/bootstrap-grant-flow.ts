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
} from "./bootstrap-delegation-coordinator.js";
import type { ByokPollStats } from "./byok-wallet-seal-helpers.js";
import { postRegisterGrantExpect303 } from "./bootstrap-grant-setup.js";
import { sequencingBackoff } from "./arithmetic-backoff-poll.js";

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
export async function completeBootstrapGrantWithReceipt(
  opts: CompleteBootstrapGrantWithReceiptOptions,
): Promise<CompleteBootstrapGrantWithReceiptResult> {
  assertBootstrapReceiptE2eEnv();
  const signingContext = await setupBootstrapCoordinatorDelegation({
    request: opts.unauthorizedRequest,
    logId: opts.logId,
    variant: opts.variant,
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
