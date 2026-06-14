/**
 * After root bootstrap, register a **child auth** Forestrie-Grant: envelope signed by
 * owner root key (contract bootstrap); leaf sequences on **parent** log.
 */

import { randomUUID } from "node:crypto";
import type { Grant } from "@e2e-canopy-api-src/grant/types.js";
import { uuidToBytes } from "@e2e-canopy-api-src/grant/uuid-bytes.js";
import { expectAPI as expect, test } from "@e2e-fixtures/auth";
import { sequencingBackoff } from "@e2e-utils/arithmetic-backoff-poll";
import {
  completeBootstrapGrantWithReceipt,
  mintBootstrapGrant,
  signChildGrantUnderRoot,
} from "@e2e-utils/bootstrap-grant-flow";
import {
  custodianCustodySignEnv,
  custodianKmsCryptoKeyIdFromLogUuid,
  e2eCustodianKeyOwnerId,
  grantData64FromCustodianPem,
  postCustodianEnsureEs256Key,
} from "@e2e-utils/custodian-custody-grant";
import {
  assertSystemE2eEnv,
  e2eReceiptBootstrapRootLogId,
} from "@e2e-utils/e2e-env-guards";
import { authLogBootstrapShapedFlags } from "@e2e-utils/e2e-grant-flags";
import { describeForEachBootstrapVariant } from "@e2e-utils/e2e-bootstrap-variant";
import type { E2eBootstrapVariant } from "@e2e-utils/e2e-bootstrap-variant";
import { completeGrantRegistrationThroughReceipt } from "@e2e-utils/register-grant-through-receipt";

describeForEachBootstrapVariant(
  "Bootstrap root + child auth grant e2e",
  (variant: E2eBootstrapVariant) => {
    test.describe.configure({ mode: "serial" });

    test("POST /register/grants (child grant) returns 303 to parent entries; receipt polls", async ({
      unauthorizedRequest,
    }, testInfo) => {
      assertSystemE2eEnv();
      const custodyEnv = custodianCustodySignEnv()!;

      const rootLogId = e2eReceiptBootstrapRootLogId();
      const childLogId = randomUUID();
      const baseURL = testInfo.project.use.baseURL ?? "";

      const { grantBase64: mintGrantB64 } = await mintBootstrapGrant(
        unauthorizedRequest,
        rootLogId,
        variant,
      );

      const { receiptRes } = await completeBootstrapGrantWithReceipt({
        unauthorizedRequest,
        logId: rootLogId,
        baseURL,
        grantBase64: mintGrantB64,
        variant,
        ladderMs: sequencingBackoff,
      });
      expect(receiptRes.status).toBe(200);

      const { keyId, publicKeyPem } = await postCustodianEnsureEs256Key({
        baseUrl: custodyEnv.baseUrl,
        appToken: custodyEnv.token,
        keyOwnerId: e2eCustodianKeyOwnerId(),
        selfLogId: childLogId,
      });
      const expectedKmsId = custodianKmsCryptoKeyIdFromLogUuid(childLogId);
      const kmsSegment = keyId.split("/cryptoKeys/").pop() ?? keyId;
      expect(kmsSegment).toBe(expectedKmsId);

      const grant: Grant = {
        logId: uuidToBytes(childLogId),
        ownerLogId: uuidToBytes(rootLogId),
        grant: authLogBootstrapShapedFlags(),
        maxHeight: 0,
        minGrowth: 0,
        grantData: grantData64FromCustodianPem(publicKeyPem),
      };

      const grantBase64 = signChildGrantUnderRoot(variant, grant);

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
  },
);
