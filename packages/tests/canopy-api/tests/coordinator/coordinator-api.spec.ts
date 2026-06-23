/**
 * Phase 3 delegation-coordinator management APIs + custodian proxy issuance.
 *
 * Requires DELEGATION_COORDINATOR_URL, COORDINATOR_APP_TOKEN, CUSTODIAN_URL,
 * CUSTODIAN_APP_TOKEN (Doppler canopy/dev or CI GitHub Environment dev).
 */

import { randomUUID } from "node:crypto";
import { encode as encodeCbor } from "cbor-x";
import { test, expect } from "@playwright/test";
import {
  assertCoordinatorApiE2eEnv,
  hasCoordinatorApiE2eEnv,
} from "@e2e-utils/coordinator-api-env.js";
import {
  bytesToBase64,
  decodeCoordinatorDelegationIssue,
  fetchLogPendingDelegation,
  generateEphemeralDelegatedPublicKeyCbor,
  hex32ToWireLogId,
  postCustodianDelegationIssue,
  uploadByokRootPublicKey,
} from "@e2e-utils/coordinator-delegation-helpers.js";
import { publicKeyPemToUncompressed65 } from "@e2e-canopy-api-src/scrapi/custodian-grant.js";
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
  let authCustodianPublicKeyPem: string;

  test("health", async ({ request }) => {
    const res = await request.get(
      `${coordinatorUrl}/_delegation-coordinator/health`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok" });
  });

  test("GET pending-delegation — empty for fresh auth log", async ({
    request,
  }) => {
    const body = await fetchLogPendingDelegation({
      request,
      coordinatorUrl,
      logId: authLogUuid,
    });
    expect(body.entries).toEqual([]);
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
    expect(body.publicKey).toBeTruthy();
    authCustodianPublicKeyPem = body.publicKey as string;
  });

  test("POST public-root — custodian trust root for auth log", async () => {
    const u65 = publicKeyPemToUncompressed65(authCustodianPublicKeyPem);
    const rootRes = await uploadByokRootPublicKey({
      coordinatorUrl,
      token: coordinatorToken,
      logId: authLogUuid,
      x: u65.slice(1, 33),
      y: u65.slice(33, 65),
    });
    expect(rootRes.status).toBe(200);
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
      `${coordinatorUrl}/api/delegations/certificate`,
      {
        headers: {
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

  test("POST /api/delegations — returns stored material", async ({
    request,
  }) => {
    const issueBody = {
      version: 1,
      logId: hex32ToWireLogId(authLogHex32),
      mmrStart,
      mmrEnd,
      algorithm: "ES256",
      delegatedPublicKey,
      requestedTtlSeconds: 3600,
    };
    const encoded = encodeCbor(issueBody);
    const u8 =
      encoded instanceof Uint8Array
        ? encoded
        : new Uint8Array(encoded as ArrayLike<number>);

    const res = await request.post(`${coordinatorUrl}/api/delegations`, {
      headers: {
        Authorization: `Bearer ${coordinatorToken}`,
        "Content-Type": "application/cbor",
        Accept: "application/cbor",
      },
      data: Buffer.from(u8),
    });
    if (!res.ok()) {
      const detail = await res.text();
      throw new Error(
        `coordinator issue failed: ${res.status()} ${detail.slice(0, 500)}`,
      );
    }
    const issued = decodeCoordinatorDelegationIssue(
      new Uint8Array(await res.body()),
    );
    expect(issued.certificate.byteLength).toBeGreaterThan(0);
    expect(issued.issuedAt).toBe(materialIssuedAt);
    expect(issued.expiresAt).toBe(materialExpiresAt);
  });
});
