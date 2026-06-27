/**
 * Mode C webhook-driven BYOK seal e2e (plan-0037 / FOR-126 / Package D).
 * Genesis ?webhookUrl= forwards coordinator setup; in-repo receiver signs material.
 */

import { randomUUID } from "node:crypto";
import { encode as encodeCbor } from "cbor-x";
import { expectAPI as expect, test } from "@e2e-fixtures/auth";
import { buildCompletedGrantBase64 } from "@e2e-utils/bootstrap-grant-flow";
import { postRegisterGrantExpect303 } from "@e2e-utils/bootstrap-grant-setup";
import { assertCoordinatorApiE2eEnv } from "@e2e-utils/coordinator-api-env";
import {
  decodeCoordinatorDelegationIssue,
  generateEphemeralDelegatedPublicKeyCbor,
  hex32ToWireLogId,
  verifyKs256BootstrapDelegationCertificate,
} from "@e2e-utils/coordinator-delegation-helpers";
import {
  exchangeKs256ControlPlaneSession,
  postSigningRouteWithSession,
  WALLET_CHALLENGE_KS256_SCOPES,
} from "@e2e-utils/wallet-challenge-session-e2e";
import { decodeEntryIdHex } from "@e2e-utils/entry-id-e2e";
import { ensureForestGenesisKs256WithWebhookE2e } from "@e2e-utils/forest-genesis-e2e";
import {
  ks256AddressFromPrivateKeyHex,
  mintKs256RootGrantWithWalletKey,
  randomKs256PrivateKeyHex,
  signKs256RootStatement,
} from "@e2e-utils/ks256-wallet-grant";
import { modeCWebhookSealSkipReason } from "@e2e-utils/mode-c-e2e-env";
import { startModeCWebhookIngress } from "@e2e-utils/mode-c-webhook-ingress";
import {
  decodeCoordinatorKs256PublicRootKey,
  pollRegistrationThroughModeCWebhook,
  waitForModeCDelegationMaterial,
} from "@e2e-utils/mode-c-webhook-seal-helpers";
import { mintOnboardTokenE2e } from "@e2e-utils/onboard-token-e2e";
import { normalizeForestrieHexId32 } from "@e2e-utils/forestrie-hex-id";
import { postLogEntriesCoseSign1 } from "@e2e-utils/post-entries-e2e";
import {
  ks256BootstrapContractAddrBytes,
  ks256ChainBindingSkipReason,
  univocityGenesisChainId,
  univocityProvisionSkipReason,
} from "@e2e-utils/univocity-genesis-e2e";
import { extractDelegationCertFromReceipt } from "@e2e-utils/byok-wallet-seal-helpers";

const modeCSkip = modeCWebhookSealSkipReason();

test.describe("Mode C webhook-driven BYOK seal e2e", () => {
  test.describe.configure({ mode: "serial" });

  test.skip(!!modeCSkip, modeCSkip ?? "");

  test("genesis webhook forward, delegation.required push, and checkpoint receipt verify", async ({
    unauthorizedRequest,
  }, testInfo) => {
    const skip =
      univocityProvisionSkipReason() ?? (await ks256ChainBindingSkipReason());
    test.skip(!!skip, skip ?? "");

    const coordinator = assertCoordinatorApiE2eEnv();
    const rootLogId = randomUUID();
    const rootLogHex32 = normalizeForestrieHexId32(rootLogId);
    const baseURL = testInfo.project.use.baseURL ?? "";
    const privateKeyHex = randomKs256PrivateKeyHex();
    const rootAddress = ks256AddressFromPrivateKeyHex(privateKeyHex);
    const signedMaterialKeys = new Set<string>();

    const ingress = await startModeCWebhookIngress({
      coordinatorBaseUrl: coordinator.baseUrl,
      coordinatorAppToken: coordinator.appToken,
      rootSignerAddress: rootAddress,
      privateKeyHex,
      logIdUuid: rootLogId,
    });

    try {
      const onboardToken = await mintOnboardTokenE2e(unauthorizedRequest);

      await ensureForestGenesisKs256WithWebhookE2e(unauthorizedRequest, {
        logId: rootLogId,
        onboardToken,
        ks256Address: rootAddress,
        univocityAddr: ks256BootstrapContractAddrBytes(),
        chainId: univocityGenesisChainId(),
        webhookUrl: ingress.webhookUrl,
      });

      const webhookGet = await unauthorizedRequest.get(
        `${coordinator.baseUrl}/api/logs/${rootLogId}/webhook`,
        {
          headers: { Authorization: `Bearer ${coordinator.appToken}` },
        },
      );
      expect(webhookGet.status()).toBe(200);
      const webhookBody = (await webhookGet.json()) as { webhookUrl?: string };
      expect(webhookBody.webhookUrl).toBe(ingress.webhookUrl);

      const rootGet = await fetch(
        `${coordinator.baseUrl}/api/logs/${rootLogId}/public-root`,
        {
          method: "GET",
          headers: {
            Accept: "application/cbor",
          },
        },
      );
      expect(rootGet.status).toBe(200);
      const registeredRoot = decodeCoordinatorKs256PublicRootKey(
        new Uint8Array(await rootGet.arrayBuffer()),
      );
      expect(Buffer.from(registeredRoot).equals(Buffer.from(rootAddress))).toBe(
        true,
      );

      const session = await exchangeKs256ControlPlaneSession({
        request: unauthorizedRequest,
        coordinatorUrl: coordinator.baseUrl,
        authLogId: rootLogId,
        scopes: WALLET_CHALLENGE_KS256_SCOPES,
        privateKeyHex,
      });
      await postSigningRouteWithSession({
        request: unauthorizedRequest,
        coordinatorUrl: coordinator.baseUrl,
        logId: rootLogId,
        sessionToken: session.token,
        mode: "wallet",
      });

      const delegatedPublicKey =
        await generateEphemeralDelegatedPublicKeyCbor();
      const issueMiss = await unauthorizedRequest.post(
        `${coordinator.baseUrl}/api/delegations`,
        {
          headers: {
            Authorization: `Bearer ${coordinator.appToken}`,
            "Content-Type": "application/cbor",
            Accept: "application/cbor",
          },
          data: Buffer.from(
            encodeCbor({
              version: 1,
              logId: hex32ToWireLogId(rootLogHex32),
              mmrStart: 1,
              mmrEnd: 8,
              algorithm: "ES256",
              delegatedPublicKey,
              requestedTtlSeconds: 3600,
            }) as Uint8Array,
          ),
        },
      );
      expect(issueMiss.status()).toBe(202);

      const delivery = await waitForModeCDelegationMaterial({
        request: unauthorizedRequest,
        coordinatorUrl: coordinator.baseUrl,
        coordinatorToken: coordinator.appToken,
        logIdUuid: rootLogId,
        receiverStats: ingress.receiver.stats,
        rootSignerAddress: rootAddress,
        privateKeyHex,
        mmrStart: 1,
        mmrEnd: 8,
        delegatedPublicKey,
      });
      expect(delivery).toBe("webhook");
      expect(ingress.receiver.stats.webhooksReceived).toBeGreaterThan(0);
      expect(ingress.receiver.stats.materialsSubmitted).toBeGreaterThan(0);

      const issueHit = await unauthorizedRequest.post(
        `${coordinator.baseUrl}/api/delegations`,
        {
          headers: {
            Authorization: `Bearer ${coordinator.appToken}`,
            "Content-Type": "application/cbor",
            Accept: "application/cbor",
          },
          data: Buffer.from(
            encodeCbor({
              version: 1,
              logId: hex32ToWireLogId(rootLogHex32),
              mmrStart: 1,
              mmrEnd: 8,
              algorithm: "ES256",
              delegatedPublicKey,
              requestedTtlSeconds: 3600,
            }) as Uint8Array,
          ),
        },
      );
      expect(issueHit.ok()).toBeTruthy();
      const issued = decodeCoordinatorDelegationIssue(
        new Uint8Array(await issueHit.body()),
      );
      expect(
        await verifyKs256BootstrapDelegationCertificate({
          certificate: issued.certificate,
          rootSignerAddress: rootAddress,
        }),
      ).toBe(true);

      const { grantBase64: mintGrantB64 } = mintKs256RootGrantWithWalletKey({
        rootLogId,
        bootstrapAddress20: rootAddress,
        ks256PrivateKeyHex: privateKeyHex,
      });

      const { statusUrlAbsolute } = await postRegisterGrantExpect303(
        unauthorizedRequest,
        {
          bootstrapLogId: rootLogId,
          baseURL,
          grantBase64: mintGrantB64,
        },
      );

      const coordinatorPoll = {
        coordinatorUrl: coordinator.baseUrl,
        coordinatorToken: coordinator.appToken,
        logIdUuid: rootLogId,
        privateKeyHex,
        signedMaterialKeys,
      };

      const webhooksBeforeGrant = ingress.receiver.stats.webhooksReceived;

      const grantComplete = await pollRegistrationThroughModeCWebhook({
        request: unauthorizedRequest,
        statusUrlAbsolute,
        baseURL,
        receiverStats: ingress.receiver.stats,
        rootSignerAddress: rootAddress,
        coordinatorPoll,
      });
      expect(ingress.receiver.stats.webhooksReceived).toBeGreaterThan(
        webhooksBeforeGrant,
      );
      expect(grantComplete.receiptRes.status).toBe(200);
      expect(
        await verifyKs256BootstrapDelegationCertificate({
          certificate: extractDelegationCertFromReceipt(
            grantComplete.receiptRes.body,
          ),
          rootSignerAddress: rootAddress,
        }),
      ).toBe(true);
      expect(decodeEntryIdHex(grantComplete.entryIdHex).mmrIndex).toBe(0n);

      const completedGrantB64 = buildCompletedGrantBase64(
        mintGrantB64,
        grantComplete.receiptRes.body,
        grantComplete.entryIdHex,
      );
      const statementPayload = new TextEncoder().encode(
        `Mode C webhook seal ${rootLogId}`,
      );
      const statementSign1 = signKs256RootStatement(
        statementPayload,
        privateKeyHex,
      );
      const entryRes = await postLogEntriesCoseSign1(unauthorizedRequest, {
        bootstrapLogId: rootLogId,
        logId: rootLogId,
        completedGrantB64,
        sign1Bytes: statementSign1,
      });
      expect(entryRes.status()).toBe(303);

      const entryStatusUrl = absoluteUrl(baseURL, entryRes.headers().location!);
      const webhooksBeforeEntry = ingress.receiver.stats.webhooksReceived;
      const entryComplete = await pollRegistrationThroughModeCWebhook({
        request: unauthorizedRequest,
        statusUrlAbsolute: entryStatusUrl,
        baseURL,
        receiverStats: ingress.receiver.stats,
        rootSignerAddress: rootAddress,
        coordinatorPoll,
      });
      expect(ingress.receiver.stats.webhooksReceived).toBeGreaterThan(
        webhooksBeforeEntry,
      );
      expect(entryComplete.receiptRes.status).toBe(200);
      expect(
        await verifyKs256BootstrapDelegationCertificate({
          certificate: extractDelegationCertFromReceipt(
            entryComplete.receiptRes.body,
          ),
          rootSignerAddress: rootAddress,
        }),
      ).toBe(true);
    } finally {
      await ingress.close();
    }
  });
});

function absoluteUrl(baseURL: string, location: string): string {
  if (location.startsWith("http")) return location;
  const base = baseURL.replace(/\/$/, "");
  return `${base}${location.startsWith("/") ? location : `/${location}`}`;
}
