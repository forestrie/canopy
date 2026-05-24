/**
 * Stretch: wallet-managed delegation material + custodian proxy on a dedicated log.
 *
 * Opt-in via E2E_COORDINATOR_SEALER_STRETCH=1 (does not run in default CI system suite).
 * Full sealer defer/recover polling is deferred; this proves proxy issuance only.
 */

import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { assertCustodianApiE2eEnv } from "@e2e-utils/custodian-api-env.js";
import {
  assertCoordinatorApiE2eEnv,
  hasCoordinatorApiE2eEnv,
} from "@e2e-utils/coordinator-api-env.js";
import {
  bytesToBase64,
  generateEphemeralDelegatedPublicKeyCbor,
  postCustodianDelegationIssue,
} from "@e2e-utils/coordinator-delegation-helpers.js";
import { normalizeForestrieHexId32 } from "@e2e-utils/forestrie-hex-id.js";

const stretchEnabled = process.env.E2E_COORDINATOR_SEALER_STRETCH === "1";

test.describe("coordinator delegation issuance (stretch)", () => {
  test.skip(
    !stretchEnabled || !hasCoordinatorApiE2eEnv(),
    "Set E2E_COORDINATOR_SEALER_STRETCH=1 and coordinator env vars to run",
  );

  test("wallet-managed log: material + custodian proxy issuance", async ({
    request,
  }) => {
    const { baseUrl: coordinatorUrl, appToken: coordinatorToken } =
      assertCoordinatorApiE2eEnv();
    const { baseUrl: custodianUrl, appToken: custodianToken } =
      assertCustodianApiE2eEnv();

    const logUuid = randomUUID();
    const logHex32 = normalizeForestrieHexId32(logUuid);
    const mmrStart = 0;
    const mmrEnd = 2048;

    const keyRes = await request.post(
      `${coordinatorUrl}/api/logs/${logUuid}/custody-keys`,
      {
        headers: {
          Authorization: `Bearer ${coordinatorToken}`,
          "Content-Type": "application/json",
        },
        data: {
          keyOwnerId: `e2e-stretch-${logHex32.slice(0, 8)}`,
          alg: "ES256",
        },
      },
    );
    expect(keyRes.ok()).toBeTruthy();

    const delegatedPublicKey = await generateEphemeralDelegatedPublicKeyCbor();
    const issued = await postCustodianDelegationIssue({
      custodianBaseUrl: custodianUrl,
      appToken: custodianToken,
      logIdHex32: logHex32,
      mmrStart,
      mmrEnd,
      delegatedPublicKey,
    });

    const materialRes = await request.post(
      `${coordinatorUrl}/api/delegations/material`,
      {
        headers: {
          Authorization: `Bearer ${coordinatorToken}`,
          "Content-Type": "application/json",
        },
        data: {
          logId: logUuid,
          mmrStart,
          mmrEnd,
          delegatedPublicKey: bytesToBase64(delegatedPublicKey),
          certificate: bytesToBase64(issued.certificate),
          issuedAt: issued.issuedAt,
          expiresAt: issued.expiresAt,
        },
      },
    );
    expect(materialRes.ok()).toBeTruthy();

    await request.post(
      `${coordinatorUrl}/api/logs/${logUuid}/signing-route`,
      {
        headers: {
          Authorization: `Bearer ${coordinatorToken}`,
          "Content-Type": "application/json",
        },
        data: { mode: "wallet" },
      },
    );

    const proxied = await postCustodianDelegationIssue({
      custodianBaseUrl: custodianUrl,
      appToken: custodianToken,
      logIdHex32: logHex32,
      mmrStart,
      mmrEnd,
      delegatedPublicKey,
    });
    expect(proxied.certificate.byteLength).toBeGreaterThan(0);
  });
});
