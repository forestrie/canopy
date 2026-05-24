/**
 * Phase 3 delegation-coordinator management APIs + custodian proxy issuance.
 *
 * Requires DELEGATION_COORDINATOR_URL, COORDINATOR_APP_TOKEN, CUSTODIAN_URL,
 * CUSTODIAN_APP_TOKEN (Doppler canopy/dev or CI GitHub Environment dev).
 */

import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import {
  assertCoordinatorApiE2eEnv,
  hasCoordinatorApiE2eEnv,
} from "@e2e-utils/coordinator-api-env.js";
import {
  bytesToBase64,
  generateEphemeralDelegatedPublicKeyCbor,
  postCustodianDelegationIssue,
} from "@e2e-utils/coordinator-delegation-helpers.js";
import { assertCustodianApiE2eEnv } from "@e2e-utils/custodian-api-env.js";
import { normalizeForestrieHexId32 } from "@e2e-utils/forestrie-hex-id.js";
import { e2eCustodianKeyOwnerId } from "@e2e-utils/custodian-custody-grant.js";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  if (!hasCoordinatorApiE2eEnv()) {
    throw new Error(
      "Coordinator e2e requires DELEGATION_COORDINATOR_URL and COORDINATOR_APP_TOKEN.",
    );
  }
  assertCustodianApiE2eEnv();
});

test.describe("delegation-coordinator APIs", () => {
  const { baseUrl: coordinatorUrl, appToken: coordinatorToken } =
    assertCoordinatorApiE2eEnv();
  const { baseUrl: custodianUrl, appToken: custodianToken } =
    assertCustodianApiE2eEnv();

  const authLogUuid = randomUUID();
  const authLogHex32 = normalizeForestrieHexId32(authLogUuid);
  const childLogUuid = randomUUID();
  const childLogHex32 = normalizeForestrieHexId32(childLogUuid);

  const mmrStart = 0;
  const mmrEnd = 1024;
  let delegatedPublicKey: Uint8Array;
  let materialIssuedAt: number;
  let materialExpiresAt: number;
  let materialCertificateB64: string;

  test("health", async ({ request }) => {
    const res = await request.get(
      `${coordinatorUrl}/_delegation-coordinator/health`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok" });
  });

  test("GET pending — empty for fresh auth log", async ({ request }) => {
    const res = await request.get(
      `${coordinatorUrl}/api/delegations/pending?authLogId=${authLogUuid}`,
      {
        headers: { Authorization: `Bearer ${coordinatorToken}` },
      },
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.entries).toEqual([]);
    expect(body.shardCount).toBe(4);
  });

  test("POST custody-keys — create custodian key for auth log", async ({
    request,
  }) => {
    const res = await request.post(
      `${coordinatorUrl}/api/logs/${authLogUuid}/custody-keys`,
      {
        headers: {
          Authorization: `Bearer ${coordinatorToken}`,
          "Content-Type": "application/json",
        },
        data: {
          keyOwnerId: e2eCustodianKeyOwnerId(),
          alg: "ES256",
        },
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.keyId).toBeTruthy();
  });

  test("POST custody-keys — create custodian key for child log", async ({
    request,
  }) => {
    const res = await request.post(
      `${coordinatorUrl}/api/logs/${childLogUuid}/custody-keys`,
      {
        headers: {
          Authorization: `Bearer ${coordinatorToken}`,
          "Content-Type": "application/json",
        },
        data: {
          keyOwnerId: e2eCustodianKeyOwnerId(),
          alg: "ES256",
        },
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.keyId).toBeTruthy();
    expect(body.publicKey).toBeTruthy();
  });

  test("mint delegation material via custodian (pre-wallet route)", async () => {
    delegatedPublicKey = await generateEphemeralDelegatedPublicKeyCbor();
    const issued = await postCustodianDelegationIssue({
      custodianBaseUrl: custodianUrl,
      appToken: custodianToken,
      logIdHex32: authLogHex32,
      mmrStart,
      mmrEnd,
      delegatedPublicKey,
    });
    materialIssuedAt = issued.issuedAt;
    materialExpiresAt = issued.expiresAt;
    materialCertificateB64 = bytesToBase64(issued.certificate);
    expect(issued.certificate.byteLength).toBeGreaterThan(0);
  });

  test("POST material — store pre-signed certificate", async ({ request }) => {
    const res = await request.post(
      `${coordinatorUrl}/api/delegations/material`,
      {
        headers: {
          Authorization: `Bearer ${coordinatorToken}`,
          "Content-Type": "application/json",
        },
        data: {
          logId: authLogUuid,
          mmrStart,
          mmrEnd,
          delegatedPublicKey: bytesToBase64(delegatedPublicKey),
          certificate: materialCertificateB64,
          issuedAt: materialIssuedAt,
          expiresAt: materialExpiresAt,
        },
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("POST signing-route — wallet-managed auth log", async ({ request }) => {
    const res = await request.post(
      `${coordinatorUrl}/api/logs/${authLogUuid}/signing-route`,
      {
        headers: {
          Authorization: `Bearer ${coordinatorToken}`,
          "Content-Type": "application/json",
        },
        data: { mode: "wallet" },
      },
    );
    expect(res.status()).toBe(200);
    const getRes = await request.get(
      `${coordinatorUrl}/api/logs/${authLogHex32}/signing-route`,
      {
        headers: { Authorization: `Bearer ${coordinatorToken}` },
      },
    );
    expect(getRes.ok()).toBeTruthy();
    const route = await getRes.json();
    expect(route.mode).toBe("wallet");
  });

  test("POST /api/delegations via custodian — proxy returns stored material", async () => {
    const proxied = await postCustodianDelegationIssue({
      custodianBaseUrl: custodianUrl,
      appToken: custodianToken,
      logIdHex32: authLogHex32,
      mmrStart,
      mmrEnd,
      delegatedPublicKey,
    });
    expect(proxied.certificate.byteLength).toBeGreaterThan(0);
    expect(proxied.issuedAt).toBe(materialIssuedAt);
    expect(proxied.expiresAt).toBe(materialExpiresAt);
  });
});
