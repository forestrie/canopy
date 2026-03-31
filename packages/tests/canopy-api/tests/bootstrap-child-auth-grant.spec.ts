/**
 * After root bootstrap, register a **child auth** Forestrie-Grant (ARC-0017): custody ES256 key
 * signs grant with logId = child, ownerLogId = root; leaf sequences on **parent** log.
 *
 * Custodian `POST /api/keys` requires a valid `selfLogId` UUID; the KMS key id is that UUID
 * with hyphens removed (`custodianKmsCryptoKeyIdFromLogUuid` in `custodian-custody-grant.ts`).
 */

import { randomUUID } from "node:crypto";
import { expectAPI as expect, test } from "./fixtures/auth";
import {
  pollQueryRegistrationUntilReceiptRedirect,
  pollResolveReceiptUntil200,
  sequencingBackoff,
} from "./utils/arithmetic-backoff-poll";
import {
  completeBootstrapGrantWithReceipt,
  mintBootstrapGrantPlaywright,
  shouldSkipSequencingPoll,
} from "./utils/bootstrap-grant-flow";
import { custodianBootstrapSignEnv } from "./utils/custodian-bootstrap-sign";
import {
  authLogBootstrapShapedFlags,
  custodianCustodySignEnv,
  custodianKmsCryptoKeyIdFromLogUuid,
  grantData64FromCustodianPem,
  postCustodianCreateEs256Key,
  signGrantPayloadWithCustodyKey,
} from "./utils/custodian-custody-grant";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
} from "./utils/problem-details";
import type { Grant } from "../../../apps/canopy-api/src/grant/types.js";
import { uuidToBytes } from "../../../apps/canopy-api/src/grant/uuid-bytes.js";

test.describe("Bootstrap root + child auth grant e2e", () => {
  test.describe.configure({ mode: "serial" });

  test("POST /logs/{child}/grants returns 303 to parent entries; receipt polls", async ({
    unauthorizedRequest,
  }, testInfo) => {
    if (shouldSkipSequencingPoll()) {
      testInfo.skip(
        true,
        "E2E_SKIP_SEQUENCING_POLL: skip until SCITT / ingress",
      );
      return;
    }

    if (!custodianBootstrapSignEnv()) {
      testInfo.skip(
        true,
        "CUSTODIAN_URL and CUSTODIAN_BOOTSTRAP_APP_TOKEN required for root bootstrap",
      );
      return;
    }

    const custodyEnv = custodianCustodySignEnv();
    if (!custodyEnv) {
      testInfo.skip(
        true,
        "CUSTODIAN_URL and CUSTODIAN_APP_TOKEN required for custody child-auth grant",
      );
      return;
    }

    test.setTimeout(600_000);
    const rootLogId = randomUUID();
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

    const registerRes = await unauthorizedRequest.post(
      `/logs/${childLogId}/grants`,
      {
        headers: {
          Authorization: `Forestrie-Grant ${grantBase64}`,
        },
        maxRedirects: 0,
      },
    );

    const regProblem = await reportProblemDetails(registerRes, testInfo);
    const regHint =
      formatProblemDetailsMessage(regProblem) ??
      (await registerRes.text().then((t) => t.slice(0, 300)));
    expect(registerRes.status(), regHint).toBe(303);

    const loc = registerRes.headers()["location"];
    expect(loc).toBeTruthy();
    const locLower = loc!.toLowerCase();
    expect(locLower).toContain(`/logs/${rootLogId.toLowerCase()}/entries/`);
    expect(locLower).not.toContain(
      `/logs/${childLogId.toLowerCase()}/entries/`,
    );

    const statusAbsolute = loc!.startsWith("http")
      ? loc!
      : `${baseURL.replace(/\/$/, "")}${loc!.startsWith("/") ? "" : "/"}${loc!}`;

    const { receiptUrlAbsolute } =
      await pollQueryRegistrationUntilReceiptRedirect({
        request: unauthorizedRequest,
        statusUrlAbsolute: statusAbsolute,
        baseURL,
        ladderMs: sequencingBackoff,
        maxWaitMs: 180_000,
      });

    const childReceipt = await pollResolveReceiptUntil200({
      request: unauthorizedRequest,
      receiptUrlAbsolute,
      ladderMs: sequencingBackoff,
      maxWaitMs: 420_000,
    });
    expect(childReceipt.status).toBe(200);
  });
});
