/**
 * After root bootstrap, register a **child auth** Forestrie-Grant (ARC-0017): custody ES256 key
 * signs grant with logId = child, ownerLogId = root; leaf sequences on **parent** log.
 *
 * Custodian `POST /api/keys` requires `keyOwnerId` and `selfLogId` as **32 lowercase hex digits**
 * (optional hyphens); KMS CryptoKey id matches `selfLogId` normalized (`custodianKmsCryptoKeyIdFromLogUuid`).
 */

import { randomUUID } from "node:crypto";
import type { Grant } from "@e2e-canopy-api-src/grant/types.js";
import { uuidToBytes } from "@e2e-canopy-api-src/grant/uuid-bytes.js";
import { expectAPI as expect, test } from "@e2e-fixtures/auth";
import { sequencingBackoff } from "@e2e-utils/arithmetic-backoff-poll";
import {
  completeBootstrapGrantWithReceipt,
  mintBootstrapGrant,
} from "@e2e-utils/bootstrap-grant-flow";
import {
  custodianCustodySignEnv,
  custodianKmsCryptoKeyIdFromLogUuid,
  e2eCustodianKeyOwnerId,
  grantData64FromCustodianPem,
  postCustodianCreateEs256Key,
  signGrantPayloadWithCustodyKey,
} from "@e2e-utils/custodian-custody-grant";
import {
  assertSystemE2eEnv,
  e2eReceiptBootstrapRootLogId,
} from "@e2e-utils/e2e-env-guards";
import { authLogBootstrapShapedFlags } from "@e2e-utils/e2e-grant-flags";
import { completeGrantRegistrationThroughReceipt } from "@e2e-utils/register-grant-through-receipt";

test.describe("Bootstrap root + child auth grant e2e", () => {
  test.describe.configure({ mode: "serial" });

  test("POST /register/grants (child grant) returns 303 to parent entries; receipt polls", async ({
    unauthorizedRequest,
  }, testInfo) => {
    assertSystemE2eEnv();
    const custodyEnv = custodianCustodySignEnv()!;

    test.setTimeout(600_000);
    const rootLogId = e2eReceiptBootstrapRootLogId();
    const childLogId = randomUUID();
    const baseURL = testInfo.project.use.baseURL ?? "";

    const { grantBase64: mintGrantB64 } = await mintBootstrapGrant(
      unauthorizedRequest,
      rootLogId,
    );

    const { receiptRes } = await completeBootstrapGrantWithReceipt({
      unauthorizedRequest,
      logId: rootLogId,
      baseURL,
      grantBase64: mintGrantB64,
      ladderMs: sequencingBackoff,
    });
    expect(receiptRes.status).toBe(200);

    const { keyId, publicKeyPem } = await postCustodianCreateEs256Key({
      baseUrl: custodyEnv.baseUrl,
      appToken: custodyEnv.token,
      keyOwnerId: e2eCustodianKeyOwnerId(),
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
      bootstrapLogId: rootLogId,
      baseURL,
      grantBase64,
      ladderMs: sequencingBackoff,
    });
    expect(childComplete.receiptRes.status).toBe(200);
    expect(childComplete.statusUrlAbsolute.toLowerCase()).toContain(
      `/logs/${rootLogId.toLowerCase()}/${rootLogId.toLowerCase()}/entries/`,
    );
    expect(childComplete.statusUrlAbsolute.toLowerCase()).not.toContain(
      `/logs/${rootLogId.toLowerCase()}/${childLogId.toLowerCase()}/entries/`,
    );
  });
});
