/**
 * BYOK checkpoint seal e2e: runner-held root key, coordinator public-root,
 * wallet-signed delegation material, Sealer checkpoint, and receipt return.
 */

import { randomUUID } from "node:crypto";
import { expectAPI as expect, test } from "@e2e-fixtures/auth";
import { buildCompletedGrantBase64 } from "@e2e-utils/bootstrap-grant-flow";
import {
  assertCoordinatorApiE2eEnv,
  hasCoordinatorApiE2eEnv,
  coordinatorAppToken,
  delegationCoordinatorBaseUrl,
} from "@e2e-utils/coordinator-api-env";
import {
  exportEs256RootXy,
  generateEs256RootKeyPair,
  uploadByokRootPublicKey,
  verifyByokDelegationCertificate,
} from "@e2e-utils/coordinator-delegation-helpers";
import { decodeEntryIdHex } from "@e2e-utils/entry-id-e2e";
import { normalizeForestrieHexId32 } from "@e2e-utils/forestrie-hex-id";
import {
  extractDelegationCertFromReceipt,
  mintByokBootstrapGrant,
  pollRegistrationThroughByokReceipt,
  signByokStatement,
} from "@e2e-utils/byok-wallet-seal-helpers";
import {
  assert303ContentHashLocation,
  postLogEntriesCoseSign1,
} from "@e2e-utils/post-entries-e2e";
import { postRegisterGrantExpect303 } from "@e2e-utils/bootstrap-grant-setup";
import { sha256Hex } from "@e2e-utils/statement-sign-bytes";

const enabled = process.env.E2E_BYOK_SEAL_STRETCH === "1";

test.describe("BYOK checkpoint seal e2e", () => {
  test.describe.configure({ mode: "serial" });

  test.skip(
    !enabled,
    "Set E2E_BYOK_SEAL_STRETCH=1 to run deployed BYOK checkpoint seal e2e.",
  );

  test.beforeAll(() => {
    if (
      !hasCoordinatorApiE2eEnv() ||
      !process.env.CURATOR_ADMIN_TOKEN?.trim()
    ) {
      throw new Error(
        "BYOK seal e2e requires DELEGATION_COORDINATOR_URL, " +
          "COORDINATOR_APP_TOKEN, and CURATOR_ADMIN_TOKEN.",
      );
    }
  });

  test("wallet-managed log seals bootstrap grant and entry receipts", async ({
    unauthorizedRequest,
  }, testInfo) => {
    const coordinator = assertCoordinatorApiE2eEnv();
    const rootLogId = randomUUID();
    const rootLogHex32 = normalizeForestrieHexId32(rootLogId);
    const baseURL = testInfo.project.use.baseURL ?? "";
    const rootKeyPair = await generateEs256RootKeyPair();
    const signedMaterialKeys = new Set<string>();
    const byokPollStats = {
      pendingEntriesSeen: 0,
      materialSigned: 0,
    };

    const { x, y } = await exportEs256RootXy(rootKeyPair);
    const publicRoot = await uploadByokRootPublicKey({
      coordinatorUrl: coordinator.baseUrl,
      token: coordinator.appToken,
      logId: rootLogId,
      x,
      y,
    });
    expect(publicRoot.status).toBe(200);

    const signingRoute = await unauthorizedRequest.post(
      `${coordinator.baseUrl}/api/logs/${rootLogId}/signing-route`,
      {
        headers: {
          Authorization: `Bearer ${coordinator.appToken}`,
          "Content-Type": "application/json",
        },
        data: { mode: "wallet" },
      },
    );
    expect(signingRoute.status()).toBe(200);

    const { grantBase64: mintGrantB64, grantData } =
      await mintByokBootstrapGrant({
        request: unauthorizedRequest,
        rootLogId,
        curatorToken: process.env.CURATOR_ADMIN_TOKEN!.trim(),
        rootKeyPair,
      });

    const { statusUrlAbsolute } = await postRegisterGrantExpect303(
      unauthorizedRequest,
      {
        bootstrapLogId: rootLogId,
        baseURL,
        grantBase64: mintGrantB64,
      },
    );

    const grantComplete = await pollRegistrationThroughByokReceipt({
      request: unauthorizedRequest,
      statusUrlAbsolute,
      baseURL,
      coordinatorUrl: delegationCoordinatorBaseUrl()!,
      coordinatorToken: coordinatorAppToken()!,
      logId: rootLogId,
      logIdHex32: rootLogHex32,
      rootKeyPair,
      signedMaterialKeys,
      stats: byokPollStats,
    });
    expect(grantComplete.receiptRes.status).toBe(200);
    expect(
      await verifyByokDelegationCertificate({
        certificate: extractDelegationCertFromReceipt(
          grantComplete.receiptRes.body,
        ),
        rootPublicKey: rootKeyPair.publicKey,
      }),
    ).toBe(true);
    expect(decodeEntryIdHex(grantComplete.entryIdHex).mmrIndex).toBe(0n);

    const completedGrantB64 = buildCompletedGrantBase64(
      mintGrantB64,
      grantComplete.receiptRes.body,
      grantComplete.entryIdHex,
    );
    const statementPayload = new TextEncoder().encode(
      `BYOK checkpoint seal ${rootLogId}`,
    );
    const statementSign1 = await signByokStatement({
      rootKeyPair,
      grantData,
      payload: statementPayload,
    });
    const entryRes = await postLogEntriesCoseSign1(unauthorizedRequest, {
      bootstrapLogId: rootLogId,
      logId: rootLogId,
      completedGrantB64,
      sign1Bytes: statementSign1,
    });
    expect(entryRes.status()).toBe(303);
    const contentHash = await sha256Hex(statementSign1);
    assert303ContentHashLocation({
      bootstrapLogId: rootLogId,
      logId: rootLogId,
      baseURL,
      location: entryRes.headers().location,
      contentHashHexLower: contentHash,
    });

    const entryStatusUrl = absoluteUrl(baseURL, entryRes.headers().location!);
    const entryComplete = await pollRegistrationThroughByokReceipt({
      request: unauthorizedRequest,
      statusUrlAbsolute: entryStatusUrl,
      baseURL,
      coordinatorUrl: coordinator.baseUrl,
      coordinatorToken: coordinator.appToken,
      logId: rootLogId,
      logIdHex32: rootLogHex32,
      rootKeyPair,
      signedMaterialKeys,
      stats: byokPollStats,
    });
    expect(entryComplete.receiptRes.status).toBe(200);
    expect(
      await verifyByokDelegationCertificate({
        certificate: extractDelegationCertFromReceipt(
          entryComplete.receiptRes.body,
        ),
        rootPublicKey: rootKeyPair.publicKey,
      }),
    ).toBe(true);
  });
});

function absoluteUrl(baseURL: string, location: string): string {
  if (location.startsWith("http")) return location;
  const base = baseURL.replace(/\/$/, "");
  return `${base}${location.startsWith("/") ? location : `/${location}`}`;
}
