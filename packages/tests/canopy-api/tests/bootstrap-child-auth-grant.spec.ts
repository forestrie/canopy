/**
 * After root bootstrap, register a **child auth** Forestrie-Grant (ARC-0017): custody ES256 key
 * signs grant with logId = child, ownerLogId = root; leaf sequences on **parent** log.
 *
 * Custodian `POST /api/keys` requires a valid `selfLogId` UUID; the KMS key id is that UUID
 * with hyphens removed (`custodianKmsCryptoKeyIdFromLogUuid` in `custodian-custody-grant.ts`).
 */

import { randomUUID } from "node:crypto";
import { expectAPI as expect, test } from "./fixtures/auth";
import { sequencingBackoff } from "./utils/arithmetic-backoff-poll";
import {
  completeBootstrapGrantWithReceipt,
  mintBootstrapGrantPlaywright,
} from "./utils/bootstrap-grant-flow";
import {
  e2eReceiptBootstrapRootLogId,
  skipSequencingPollIfDisabled,
  skipWithoutCustodianBootstrap,
  skipWithoutCustodianCustody,
} from "./utils/e2e-env-guards";
import {
  authLogBootstrapShapedFlags,
  custodianCustodySignEnv,
  custodianKmsCryptoKeyIdFromLogUuid,
  grantData64FromCustodianPem,
  postCustodianCreateEs256Key,
  signGrantPayloadWithCustodyKey,
} from "./utils/custodian-custody-grant";
import type { Grant } from "../../../apps/canopy-api/src/grant/types.js";
import { uuidToBytes } from "../../../apps/canopy-api/src/grant/uuid-bytes.js";
import { completeGrantRegistrationThroughReceipt } from "./utils/register-grant-through-receipt";

test.describe("Bootstrap root + child auth grant e2e", () => {
  test.describe.configure({ mode: "serial" });

  test("POST /register/grants (child grant) returns 303 to parent entries; receipt polls", async ({
    unauthorizedRequest,
  }, testInfo) => {
    if (skipSequencingPollIfDisabled(testInfo)) return;
    if (skipWithoutCustodianBootstrap(testInfo)) return;
    if (skipWithoutCustodianCustody(testInfo)) return;

    const custodyEnv = custodianCustodySignEnv()!;

    test.setTimeout(600_000);
    const rootLogId = e2eReceiptBootstrapRootLogId();
    const childLogId = randomUUID();
    const baseURL = testInfo.project.use.baseURL ?? "";

    const minted = await mintBootstrapGrantPlaywright(
      unauthorizedRequest,
      rootLogId,
      testInfo,
    );
    if (minted.skipped) return;

    const { receiptRes } = await completeBootstrapGrantWithReceipt({
      unauthorizedRequest,
      logId: rootLogId,
      baseURL,
      grantBase64: minted.grantBase64,
      ladderMs: sequencingBackoff,
    });
    expect(receiptRes.status).toBe(200);

    const { keyId, publicKeyPem } = await postCustodianCreateEs256Key({
      baseUrl: custodyEnv.baseUrl,
      appToken: custodyEnv.token,
      keyOwnerId: `canopy-e2e-child-auth-${childLogId}`,
      selfLogId: childLogId,
    });
    const expectedKmsId = custodianKmsCryptoKeyIdFromLogUuid(childLogId);
    const kmsSegment = keyId.split("/cryptoKeys/").pop() ?? keyId;
    expect(
      kmsSegment,
      "Custodian keyId must name the CryptoKey after selfLogId (hyphen-free UUID)",
    ).toBe(expectedKmsId);

    const grantData = grantData64FromCustodianPem(publicKeyPem);
    const grant: Grant = {
      logId: uuidToBytes(childLogId),
      ownerLogId: uuidToBytes(rootLogId),
      grant: authLogBootstrapShapedFlags(),
      maxHeight: 0,
      minGrowth: 0,
      grantData,
    };

    // Custodian paths are /api/keys/{keyId}/sign with a single segment; full KMS
    // resource names contain slashes and break routing — use the CryptoKey short id.
    const grantBase64 = await signGrantPayloadWithCustodyKey({
      baseUrl: custodyEnv.baseUrl,
      appToken: custodyEnv.token,
      keyId: kmsSegment,
      grant,
    });

    const childComplete = await completeGrantRegistrationThroughReceipt({
      unauthorizedRequest,
      logId: childLogId,
      baseURL,
      grantBase64,
      ladderMs: sequencingBackoff,
    });
    expect(childComplete.receiptRes.status).toBe(200);
    expect(childComplete.statusUrlAbsolute.toLowerCase()).toContain(
      `/logs/${rootLogId.toLowerCase()}/entries/`,
    );
    expect(childComplete.statusUrlAbsolute.toLowerCase()).not.toContain(
      `/logs/${childLogId.toLowerCase()}/entries/`,
    );
  });
});
