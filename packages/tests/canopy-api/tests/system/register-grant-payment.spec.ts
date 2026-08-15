/**
 * E2e (plan-2608-09 W3): **paid** register-grant. A parent AUTH-log grant
 * carrying `GF_DERIVED | GF_CHILD_PAYMENT_REQUIRED` (adr-0062) makes registering
 * a child grant under its authority payment-gated. The spec proves the full
 * loop: child registration 402s unpaid → succeeds once paid (EIP-3009 signed by
 * the dev payer) → seals to a receipt; and the policy bit is **offline-provable**
 * from the parent's sealed leaf (the ARC-0029 L2 beat).
 *
 * Opt-in: requires `E2E_GRANT_PAYMENT=1` AND the lane running canopy-api with
 * `REGISTER_GRANT_ADMISSION=paid|either` + `REGISTER_GRANT_PRICE_ATOMIC` (dark by
 * default — plan W5 flips the demo lane), plus a funded Base Sepolia payer key
 * (`CANOPY_X402_DEV_PRIVATE_KEY` or `DEPLOY_KEY`). Same skip-gate idiom as
 * `E2E_SEAL_HINT_LATENCY`.
 */

import { randomUUID } from "node:crypto";
import type { Grant } from "@e2e-canopy-api-src/grant/types.js";
import { uuidToBytes } from "@e2e-canopy-api-src/grant/uuid-bytes.js";
import { expectAPI as expect, test } from "@e2e-fixtures/auth";
import {
  pollQueryRegistrationUntilReceiptRedirect,
  pollResolveReceiptUntil200,
  sequencingBackoff,
} from "@e2e-utils/arithmetic-backoff-poll";
import {
  buildCompletedGrantBase64,
  completeBootstrapGrantWithReceipt,
  mintBootstrapGrant,
  signChildGrantUnderRoot,
} from "@e2e-utils/bootstrap-grant-flow";
import {
  custodianCustodySignEnv,
  e2eCustodianKeyOwnerId,
  grantData64FromCustodianPem,
  postCustodianEnsureEs256Key,
  signGrantPayloadWithCustodyKey,
} from "@e2e-utils/custodian-custody-grant";
import {
  assertSystemE2eEnv,
  e2eReceiptBootstrapRootLogId,
} from "@e2e-utils/e2e-env-guards";
import {
  authLogBootstrapShapedFlags,
  dataLogCreateExtendFlags,
  requiresChildPayment,
  withChildPaymentRequired,
} from "@e2e-utils/e2e-grant-flags";
import { getBootstrapVariant } from "@e2e-utils/e2e-bootstrap-variant";
import { completeGrantRegistrationThroughReceipt } from "@e2e-utils/register-grant-through-receipt";
import {
  postRegisterGrantWithPayment,
  x402PayerKeyE2e,
} from "@e2e-utils/register-grant-with-payment";
import {
  decodeForestrieGrantCose,
  entryIdHexToIdtimestampBe8,
  verifyGrantReceiptOffline,
} from "@forestrie/receipt-verify";

/** base64 (std or url) → bytes. */
function forestrieGrantBase64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Purchased batch ceiling; the challenge amount is price-per-unit × this. */
const CHILD_MAX_HEIGHT = 5;

const skip = (() => {
  if (process.env.E2E_GRANT_PAYMENT?.trim() !== "1") {
    return (
      "paid register-grant e2e requires E2E_GRANT_PAYMENT=1 (the lane must run " +
      "canopy-api with REGISTER_GRANT_ADMISSION=paid|either + REGISTER_GRANT_PRICE_ATOMIC)."
    );
  }
  if (!x402PayerKeyE2e()) {
    return "paid register-grant e2e requires CANOPY_X402_DEV_PRIVATE_KEY or DEPLOY_KEY (funded Base Sepolia payer).";
  }
  return null;
})();

test.describe("paid register-grant (GF_CHILD_PAYMENT_REQUIRED)", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!!skip, skip ?? "");

  // ES256 only: genesis-derived offline verify (the L2 beat) yields no keys for a
  // KS256 trust root (ADR-0045), so the policy-bit proof is asserted on ES256.
  const variant = getBootstrapVariant("es256");
  const shared = { rootLogId: "", baseURL: "" };

  test.beforeAll(async ({ unauthorizedRequest }, testInfo) => {
    assertSystemE2eEnv();
    const rootLogId = e2eReceiptBootstrapRootLogId();
    const baseURL = testInfo.project.use.baseURL ?? "";

    const { grantBase64: mintGrantB64 } = await mintBootstrapGrant(
      unauthorizedRequest,
      rootLogId,
      variant,
    );
    await completeBootstrapGrantWithReceipt({
      unauthorizedRequest,
      logId: rootLogId,
      baseURL,
      grantBase64: mintGrantB64,
      variant,
      ladderMs: sequencingBackoff,
    });

    shared.rootLogId = rootLogId;
    shared.baseURL = baseURL;
  });

  test("unpaid child registration 402s, paid succeeds, and the parent policy bit is offline-provable", async ({
    unauthorizedRequest,
  }) => {
    expect(
      shared.rootLogId,
      "beforeAll must complete root bootstrap + receipt",
    ).toBeTruthy();
    const { rootLogId, baseURL } = shared;
    const payerKey = x402PayerKeyE2e()!;
    const authLogId = randomUUID();
    const dataLogId = randomUUID();
    const delegatedSignerLogId = randomUUID();
    const custody = custodianCustodySignEnv()!;

    // 1) Parent AUTH-log grant carrying GF_DERIVED | GF_CHILD_PAYMENT_REQUIRED.
    const { keyId: authKeyId, publicKeyPem: authPubPem } =
      await postCustodianEnsureEs256Key({
        baseUrl: custody.baseUrl,
        appToken: custody.token,
        keyOwnerId: e2eCustodianKeyOwnerId(),
        selfLogId: authLogId,
      });
    const authSegment = authKeyId.split("/cryptoKeys/").pop() ?? authKeyId;

    const authGrant: Grant = {
      logId: uuidToBytes(authLogId),
      ownerLogId: uuidToBytes(rootLogId),
      grant: withChildPaymentRequired(authLogBootstrapShapedFlags()),
      maxHeight: 0,
      minGrowth: 0,
      grantData: grantData64FromCustodianPem(authPubPem),
    };
    const authGrantB64 = signChildGrantUnderRoot(variant, authGrant);
    const authRegComplete = await completeGrantRegistrationThroughReceipt({
      unauthorizedRequest,
      bootstrapLogId: rootLogId,
      baseURL,
      grantBase64: authGrantB64,
      ladderMs: sequencingBackoff,
    });
    expect(authRegComplete.receiptRes.status).toBe(200);
    const completedAuthB64 = buildCompletedGrantBase64(
      authGrantB64,
      authRegComplete.receiptRes.body,
      authRegComplete.entryIdHex,
    );

    // 2) L2 beat: the policy bit is committed in the parent's sealed leaf and
    //    provable offline from its inclusion receipt (no server trust).
    const genesisRes = await unauthorizedRequest.get(
      `/api/forest/${rootLogId}/genesis`,
    );
    expect(genesisRes.status(), "GET root genesis for offline verify").toBe(
      200,
    );
    const genesisCbor = new Uint8Array(await genesisRes.body());
    const { grant: parentGrantObj } = decodeForestrieGrantCose(
      forestrieGrantBase64ToBytes(completedAuthB64),
    );
    expect(
      requiresChildPayment(parentGrantObj.grant),
      "parent grant carries GF_DERIVED|GF_CHILD_PAYMENT_REQUIRED",
    ).toBe(true);
    const offlineVerify = await verifyGrantReceiptOffline({
      genesisCbor,
      receiptCbor: authRegComplete.receiptRes.body,
      grant: parentGrantObj,
      idtimestampBe8: entryIdHexToIdtimestampBe8(authRegComplete.entryIdHex),
    });
    expect(
      offlineVerify.ok,
      `parent offline verify: stage=${offlineVerify.stage} reason=${offlineVerify.reason ?? "unknown"}`,
    ).toBe(true);

    // 3) Child grant under the auth log, bounded to a batch (maxHeight).
    const { publicKeyPem: delPubPem } = await postCustodianEnsureEs256Key({
      baseUrl: custody.baseUrl,
      appToken: custody.token,
      keyOwnerId: e2eCustodianKeyOwnerId(),
      selfLogId: delegatedSignerLogId,
    });
    const childGrant: Grant = {
      logId: uuidToBytes(dataLogId),
      ownerLogId: uuidToBytes(authLogId),
      grant: dataLogCreateExtendFlags(),
      maxHeight: CHILD_MAX_HEIGHT,
      minGrowth: 0,
      grantData: grantData64FromCustodianPem(delPubPem),
    };
    const childGrantB64 = await signGrantPayloadWithCustodyKey({
      baseUrl: custody.baseUrl,
      appToken: custody.token,
      keyId: authSegment,
      grant: childGrant,
    });

    // 4) Unpaid → 402 challenge → sign+pay → 303 (the gate fired).
    const paid = await postRegisterGrantWithPayment({
      request: unauthorizedRequest,
      bootstrapLogId: rootLogId,
      baseURL,
      grantBase64: childGrantB64,
      parentGrantBase64: completedAuthB64,
      payerKey,
    });
    expect(
      paid.challenged,
      "gate must 402-challenge the unpaid child registration",
    ).toBe(true);
    expect(
      BigInt(paid.amountAtomic) > 0n,
      `challenge amount must be positive (got ${paid.amountAtomic})`,
    ).toBe(true);

    // 5) The paid registration seals through to a resolvable receipt.
    const { receiptUrlAbsolute, entryIdHex } =
      await pollQueryRegistrationUntilReceiptRedirect({
        request: unauthorizedRequest,
        statusUrlAbsolute: paid.statusUrlAbsolute,
        baseURL,
        ladderMs: sequencingBackoff,
      });
    const receiptRes = await pollResolveReceiptUntil200({
      request: unauthorizedRequest,
      receiptUrlAbsolute,
      ladderMs: sequencingBackoff,
    });
    expect(receiptRes.status, "paid child grant receipt resolves").toBe(200);
    expect(entryIdHex, "child grant sealed with an entry id").toBeTruthy();
  });
});
