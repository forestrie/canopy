/**
 * System-tier e2e for log root keys not held by Custodian (BYOK delegation path).
 *
 * Runner generates the log root, signs delegation material, uploads it to the
 * coordinator, then obtains the cert through Custodian POST /api/delegations
 * (proxy to coordinator when KMS has no key for the log id).
 *
 * Opt-in via E2E_COORDINATOR_SEALER_STRETCH=1 (skipped in default test:e2e:system).
 * Coordinator-only twin: tests/coordinator/coordinator-byok-material.spec.ts
 *
 * Does not prove: SCRAPI register-grant, Sealer defer/recover. Public-root:
 * coordinator-byok-public-root.spec.ts.
 */

import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { assertCustodianApiE2eEnv } from "@e2e-utils/custodian-api-env.js";
import {
  assertCoordinatorApiE2eEnv,
  hasCoordinatorApiE2eEnv,
} from "@e2e-utils/coordinator-api-env.js";
import {
  buildByokDelegationMaterial,
  bytesToBase64,
  generateEphemeralDelegatedPublicKeyCbor,
  generateEs256RootKeyPair,
  postCustodianDelegationIssue,
  verifyByokDelegationCertificate,
} from "@e2e-utils/coordinator-delegation-helpers.js";
import { normalizeForestrieHexId32 } from "@e2e-utils/forestrie-hex-id.js";
import { setupEs256WalletSigningRoute } from "@e2e-utils/wallet-challenge-session-e2e.js";

const stretchEnabled = process.env.E2E_COORDINATOR_SEALER_STRETCH === "1";

test.describe("coordinator delegation issuance (stretch)", () => {
  test.skip(
    !stretchEnabled || !hasCoordinatorApiE2eEnv(),
    "Set E2E_COORDINATOR_SEALER_STRETCH=1 and coordinator env vars to run",
  );

  test("BYOK root: custodian proxies runner-signed delegation material", async ({
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

    const rootKeyPair = await generateEs256RootKeyPair();
    const delegatedPublicKey = await generateEphemeralDelegatedPublicKeyCbor();

    await setupEs256WalletSigningRoute({
      request,
      coordinatorUrl,
      appToken: coordinatorToken,
      logId: logUuid,
      rootKeyPair,
    });

    const material = await buildByokDelegationMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart,
      mmrEnd,
      delegatedPublicKey,
    });
    expect(
      await verifyByokDelegationCertificate({
        certificate: material.certificate,
        rootPublicKey: rootKeyPair.publicKey,
      }),
    ).toBe(true);

    const materialRes = await request.post(
      `${coordinatorUrl}/api/delegations/certificate`,
      {
        headers: {
          "Content-Type": "application/json",
        },
        data: {
          logId: logUuid,
          mmrStart,
          mmrEnd,
          delegatedPublicKey: bytesToBase64(delegatedPublicKey),
          certificate: bytesToBase64(material.certificate),
          issuedAt: material.issuedAt,
          expiresAt: material.expiresAt,
        },
      },
    );
    expect(materialRes.ok()).toBeTruthy();

    const proxied = await postCustodianDelegationIssue({
      custodianBaseUrl: custodianUrl,
      appToken: custodianToken,
      logIdHex32: logHex32,
      mmrStart,
      mmrEnd,
      delegatedPublicKey,
    });

    expect(proxied.issuedAt).toBe(material.issuedAt);
    expect(proxied.expiresAt).toBe(material.expiresAt);
    expect(bytesToBase64(proxied.certificate)).toBe(
      bytesToBase64(material.certificate),
    );
    expect(
      await verifyByokDelegationCertificate({
        certificate: proxied.certificate,
        rootPublicKey: rootKeyPair.publicKey,
      }),
    ).toBe(true);
  });
});
