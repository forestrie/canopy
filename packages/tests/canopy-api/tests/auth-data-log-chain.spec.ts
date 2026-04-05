/**
 * E2e: root bootstrap → child **auth** log (custody) → first **data** log grant under auth
 * (delegated signer in grantData, signed by auth custody) → `POST /entries` on data log with
 * **delegated** key Sign1 + completed data-log Forestrie-Grant as Authorization.
 *
 * Proves statement signing for a data log can be delegated via grantData while policy is
 * established from the child auth log (`ownerLogId` chain).
 */

import { randomUUID } from "node:crypto";
import { expectAPI as expect, test } from "./fixtures/auth";
import { sequencingBackoff } from "./utils/arithmetic-backoff-poll";
import {
  buildCompletedGrantBase64,
  completeBootstrapGrantWithReceipt,
  mintBootstrapGrantPlaywright,
} from "./utils/bootstrap-grant-flow";
import {
  custodianCustodySignEnv,
  custodianKmsCryptoKeyIdFromLogUuid,
  grantData64FromCustodianPem,
  postCustodianCreateEs256Key,
  signGrantPayloadWithCustodyKey,
} from "./utils/custodian-custody-grant";
import { postCustodianSignRawPayloadBytes } from "./utils/custodian-sign-payload";
import {
  authLogBootstrapShapedFlags,
  dataLogCreateExtendFlags,
} from "./utils/e2e-grant-flags";
import {
  skipSequencingPollIfDisabled,
  skipWithoutCustodianBootstrap,
  skipWithoutCustodianCustody,
} from "./utils/e2e-env-guards";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
  responseTextPreview,
} from "./utils/problem-details";
import {
  assert303ContentHashLocation,
  postLogEntriesCoseSign1,
} from "./utils/post-entries-e2e";
import { completeGrantRegistrationThroughReceipt } from "./utils/register-grant-through-receipt";
import { sha256Hex } from "./utils/statement-sign-bytes";
import { e2eDataLogDelegationStatementPayload } from "./utils/multi-log-grant-chain";
import type { Grant } from "../../../apps/canopy-api/src/grant/types.js";
import { uuidToBytes } from "../../../apps/canopy-api/src/grant/uuid-bytes.js";

test.describe("Auth log → data log delegation chain", () => {
  test.describe.configure({ mode: "serial" });

  test("delegated signer posts register-statement on data log with data-log grant auth", async ({
    unauthorizedRequest,
  }, testInfo) => {
    if (skipSequencingPollIfDisabled(testInfo)) return;
    if (skipWithoutCustodianBootstrap(testInfo)) return;
    if (skipWithoutCustodianCustody(testInfo)) return;

    test.setTimeout(600_000);
    const rootLogId = randomUUID();
    const authLogId = randomUUID();
    const dataLogId = randomUUID();
    const delegatedSignerLogId = randomUUID();
    const baseURL = testInfo.project.use.baseURL ?? "";
    const custody = custodianCustodySignEnv()!;

    const minted = await mintBootstrapGrantPlaywright(
      unauthorizedRequest,
      rootLogId,
      testInfo,
    );
    if (minted.skipped) return;

    await completeBootstrapGrantWithReceipt({
      unauthorizedRequest,
      logId: rootLogId,
      baseURL,
      grantBase64: minted.grantBase64,
      ladderMs: sequencingBackoff,
    });

    const { keyId: authKeyId, publicKeyPem: authPubPem } =
      await postCustodianCreateEs256Key({
        baseUrl: custody.baseUrl,
        appToken: custody.token,
        keyOwnerId: `canopy-e2e-chain-auth-${authLogId}`,
        selfLogId: authLogId,
      });
    const authKms = custodianKmsCryptoKeyIdFromLogUuid(authLogId);
    const authSegment = authKeyId.split("/cryptoKeys/").pop() ?? authKeyId;
    expect(authSegment).toBe(authKms);

    const authGrant: Grant = {
      logId: uuidToBytes(authLogId),
      ownerLogId: uuidToBytes(rootLogId),
      grant: authLogBootstrapShapedFlags(),
      maxHeight: 0,
      minGrowth: 0,
      grantData: grantData64FromCustodianPem(authPubPem),
    };
    const authGrantB64 = await signGrantPayloadWithCustodyKey({
      baseUrl: custody.baseUrl,
      appToken: custody.token,
      keyId: authSegment,
      grant: authGrant,
    });

    const authRegComplete = await completeGrantRegistrationThroughReceipt({
      unauthorizedRequest,
      logId: authLogId,
      baseURL,
      grantBase64: authGrantB64,
      ladderMs: sequencingBackoff,
    });
    expect(authRegComplete.receiptRes.status).toBe(200);

    const { keyId: delKeyId, publicKeyPem: delPubPem } =
      await postCustodianCreateEs256Key({
        baseUrl: custody.baseUrl,
        appToken: custody.token,
        keyOwnerId: `as://canopy-e2e-delegated-${delegatedSignerLogId}`,
        selfLogId: delegatedSignerLogId,
      });
    const delSegment = delKeyId.split("/cryptoKeys/").pop() ?? delKeyId;
    expect(delSegment).toBe(
      custodianKmsCryptoKeyIdFromLogUuid(delegatedSignerLogId),
    );

    const dataGrant: Grant = {
      logId: uuidToBytes(dataLogId),
      ownerLogId: uuidToBytes(authLogId),
      grant: dataLogCreateExtendFlags(),
      maxHeight: 0,
      minGrowth: 0,
      grantData: grantData64FromCustodianPem(delPubPem),
    };
    const dataGrantB64 = await signGrantPayloadWithCustodyKey({
      baseUrl: custody.baseUrl,
      appToken: custody.token,
      keyId: authSegment,
      grant: dataGrant,
    });

    const dataComplete = await completeGrantRegistrationThroughReceipt({
      unauthorizedRequest,
      logId: dataLogId,
      baseURL,
      grantBase64: dataGrantB64,
      ladderMs: sequencingBackoff,
    });
    expect(dataComplete.receiptRes.status).toBe(200);

    const completedDataB64 = buildCompletedGrantBase64(
      dataGrantB64,
      dataComplete.receiptRes.body,
      dataComplete.entryIdHex,
    );

    const payload = e2eDataLogDelegationStatementPayload(dataLogId);
    const sign1Delegated = await postCustodianSignRawPayloadBytes({
      baseUrl: custody.baseUrl,
      bearerToken: custody.token,
      keyIdSegment: delSegment,
      payloadBytes: payload,
    });

    const entriesOk = await postLogEntriesCoseSign1(unauthorizedRequest, {
      logId: dataLogId,
      completedGrantB64: completedDataB64,
      sign1Bytes: sign1Delegated,
    });
    const entProblem = await reportProblemDetails(entriesOk, testInfo);
    expect(
      entriesOk.status(),
      formatProblemDetailsMessage(entProblem) ??
        (await responseTextPreview(entriesOk)),
    ).toBe(303);

    const expectedHash = await sha256Hex(sign1Delegated);
    assert303ContentHashLocation({
      logId: dataLogId,
      baseURL,
      location: entriesOk.headers().location,
      contentHashHexLower: expectedHash,
    });
  });

  test("register-statement rejects delegated grant when statement signed by auth custody key", async ({
    unauthorizedRequest,
  }, testInfo) => {
    if (skipSequencingPollIfDisabled(testInfo)) return;
    if (skipWithoutCustodianBootstrap(testInfo)) return;
    if (skipWithoutCustodianCustody(testInfo)) return;

    test.setTimeout(600_000);
    const rootLogId = randomUUID();
    const authLogId = randomUUID();
    const dataLogId = randomUUID();
    const delegatedSignerLogId = randomUUID();
    const baseURL = testInfo.project.use.baseURL ?? "";
    const custody = custodianCustodySignEnv()!;

    const minted = await mintBootstrapGrantPlaywright(
      unauthorizedRequest,
      rootLogId,
      testInfo,
    );
    if (minted.skipped) return;

    await completeBootstrapGrantWithReceipt({
      unauthorizedRequest,
      logId: rootLogId,
      baseURL,
      grantBase64: minted.grantBase64,
      ladderMs: sequencingBackoff,
    });

    const { keyId: authKeyId, publicKeyPem: authPubPem } =
      await postCustodianCreateEs256Key({
        baseUrl: custody.baseUrl,
        appToken: custody.token,
        keyOwnerId: `canopy-e2e-chain-auth-wrong-${authLogId}`,
        selfLogId: authLogId,
      });
    const authSegment = authKeyId.split("/cryptoKeys/").pop() ?? authKeyId;

    const authGrant: Grant = {
      logId: uuidToBytes(authLogId),
      ownerLogId: uuidToBytes(rootLogId),
      grant: authLogBootstrapShapedFlags(),
      maxHeight: 0,
      minGrowth: 0,
      grantData: grantData64FromCustodianPem(authPubPem),
    };
    const authGrantB64 = await signGrantPayloadWithCustodyKey({
      baseUrl: custody.baseUrl,
      appToken: custody.token,
      keyId: authSegment,
      grant: authGrant,
    });

    await completeGrantRegistrationThroughReceipt({
      unauthorizedRequest,
      logId: authLogId,
      baseURL,
      grantBase64: authGrantB64,
      ladderMs: sequencingBackoff,
    });

    const { publicKeyPem: delPubPem } = await postCustodianCreateEs256Key({
      baseUrl: custody.baseUrl,
      appToken: custody.token,
      keyOwnerId: `canopy-e2e-delegated-wrong-${delegatedSignerLogId}`,
      selfLogId: delegatedSignerLogId,
    });

    const dataGrant: Grant = {
      logId: uuidToBytes(dataLogId),
      ownerLogId: uuidToBytes(authLogId),
      grant: dataLogCreateExtendFlags(),
      maxHeight: 0,
      minGrowth: 0,
      grantData: grantData64FromCustodianPem(delPubPem),
    };
    const dataGrantB64 = await signGrantPayloadWithCustodyKey({
      baseUrl: custody.baseUrl,
      appToken: custody.token,
      keyId: authSegment,
      grant: dataGrant,
    });

    const dataComplete = await completeGrantRegistrationThroughReceipt({
      unauthorizedRequest,
      logId: dataLogId,
      baseURL,
      grantBase64: dataGrantB64,
      ladderMs: sequencingBackoff,
    });

    const completedDataB64 = buildCompletedGrantBase64(
      dataGrantB64,
      dataComplete.receiptRes.body,
      dataComplete.entryIdHex,
    );

    const payload = e2eDataLogDelegationStatementPayload(dataLogId);
    const sign1WrongSigner = await postCustodianSignRawPayloadBytes({
      baseUrl: custody.baseUrl,
      bearerToken: custody.token,
      keyIdSegment: authSegment,
      payloadBytes: payload,
    });

    const entriesBad = await postLogEntriesCoseSign1(unauthorizedRequest, {
      logId: dataLogId,
      completedGrantB64: completedDataB64,
      sign1Bytes: sign1WrongSigner,
    });
    const badProblem = await reportProblemDetails(entriesBad, testInfo);
    expect(
      entriesBad.status(),
      formatProblemDetailsMessage(badProblem) ??
        (await responseTextPreview(entriesBad)),
    ).toBe(403);
    expect(badProblem?.reason).toBe("signer_mismatch");
  });
});
