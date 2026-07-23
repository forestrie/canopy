/**
 * KS256 wallet-challenge control-plane e2e (FOR-138).
 *
 * Requires DELEGATION_COORDINATOR_URL and COORDINATOR_APP_TOKEN.
 */

import { randomUUID } from "node:crypto";
import { encodeCborDeterministic as encodeCbor } from "@forestrie/encoding";
import { test, expect } from "@playwright/test";
import {
  assertCoordinatorApiE2eEnv,
  hasCoordinatorApiE2eEnv,
} from "@e2e-utils/coordinator-api-env.js";
import {
  buildKs256BootstrapDelegationMaterial,
  bytesToBase64,
  decodeCoordinatorDelegationIssue,
  generateEphemeralDelegatedPublicKeyCbor,
  hex32ToWireLogId,
  uploadBootstrapKs256PublicRoot,
} from "@e2e-utils/coordinator-delegation-helpers.js";
import { normalizeForestrieHexId32 } from "@e2e-utils/forestrie-hex-id.js";
import {
  ks256AddressFromPrivateKeyHex,
  randomKs256PrivateKeyHex,
} from "@e2e-utils/ks256-wallet-grant.js";
import {
  exchangeKs256ControlPlaneSession,
  getSigningRouteWithSession,
  postSigningRouteWithSession,
  sessionAuthHeaders,
  WALLET_CHALLENGE_KS256_SCOPES,
} from "@e2e-utils/wallet-challenge-session-e2e.js";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  if (!hasCoordinatorApiE2eEnv()) {
    throw new Error(
      "Coordinator KS256 wallet-challenge e2e requires DELEGATION_COORDINATOR_URL and COORDINATOR_APP_TOKEN.",
    );
  }
});

test.describe("delegation-coordinator KS256 wallet-challenge", () => {
  const { baseUrl: coordinatorUrl, appToken: coordinatorToken } =
    assertCoordinatorApiE2eEnv();

  const logUuid = randomUUID();
  const logHex32 = normalizeForestrieHexId32(logUuid);
  const mmrStart = 0;
  const mmrEnd = 512;

  const privateKeyHex = randomKs256PrivateKeyHex();
  const rootAddress = ks256AddressFromPrivateKeyHex(privateKeyHex);

  let sessionToken: string;
  let delegatedPublicKey: Uint8Array;
  let materialIssuedAt: number;
  let materialExpiresAt: number;
  let materialCertificateB64: string;

  test("operator POST public-root — KS256 address", async () => {
    const res = await uploadBootstrapKs256PublicRoot({
      coordinatorUrl,
      token: coordinatorToken,
      logId: logUuid,
      address: rootAddress,
    });
    expect(res.status).toBe(200);
  });

  test("wallet-challenge session exchange", async ({ request }) => {
    const session = await exchangeKs256ControlPlaneSession({
      request,
      coordinatorUrl,
      authLogId: logUuid,
      scopes: WALLET_CHALLENGE_KS256_SCOPES,
      privateKeyHex,
    });
    expect(session.token).toBeTruthy();
    expect(session.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    sessionToken = session.token;
  });

  test("session POST/GET signing-route wallet", async ({ request }) => {
    await postSigningRouteWithSession({
      request,
      coordinatorUrl,
      logId: logUuid,
      sessionToken,
      mode: "wallet",
    });
    const route = await getSigningRouteWithSession({
      request,
      coordinatorUrl,
      logId: logUuid,
      sessionToken,
    });
    expect(route.mode).toBe("wallet");
  });

  test("service POST /api/delegations — miss creates pending", async ({
    request,
  }) => {
    delegatedPublicKey = await generateEphemeralDelegatedPublicKeyCbor();
    const encoded = encodeCbor({
      version: 1,
      logId: hex32ToWireLogId(logHex32),
      mmrStart,
      mmrEnd,
      algorithm: "KS256",
      delegatedPublicKey,
      requestedTtlSeconds: 3600,
    });
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
    expect(res.status()).toBe(202);
  });

  // Under FOR-390 phase-H membership enforcement (on for the deployed Lane A /
  // dev coordinator), the prior miss for the unregistered ephemeral key created
  // no windowed pending demand. This still exercises the wallet-challenge
  // session read path (a valid session GET returns 200); the assertion is that
  // no windowed demand for the unvouched key surfaces. See FOR-402 / FOR-390.
  test("session GET /api/delegations/pending — session reads, no demand for unregistered key (FOR-390)", async ({
    request,
  }) => {
    const res = await request.get(
      `${coordinatorUrl}/api/delegations/pending?authLogId=${logUuid}`,
      { headers: sessionAuthHeaders(sessionToken) },
    );
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      entries: Array<{
        logIdHex32: string;
        mmrStart: number;
        mmrEnd: number;
      }>;
    };
    expect(
      body.entries.some(
        (e) =>
          e.logIdHex32 === logHex32 &&
          e.mmrStart === mmrStart &&
          e.mmrEnd === mmrEnd,
      ),
    ).toBe(false);
  });

  test("public POST /api/delegations/certificate", async ({ request }) => {
    const material = await buildKs256BootstrapDelegationMaterial({
      rootSignerAddress: rootAddress,
      privateKeyHex,
      logIdHex32: logHex32,
      mmrStart,
      mmrEnd,
      delegatedPublicKey,
    });
    materialIssuedAt = material.issuedAt;
    materialExpiresAt = material.expiresAt;
    materialCertificateB64 = bytesToBase64(material.certificate);

    const res = await request.post(
      `${coordinatorUrl}/api/delegations/certificate`,
      {
        headers: { "Content-Type": "application/json" },
        data: {
          logId: logUuid,
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
  });

  test("service POST /api/delegations — returns stored material", async ({
    request,
  }) => {
    const encoded = encodeCbor({
      version: 1,
      logId: hex32ToWireLogId(logHex32),
      mmrStart,
      mmrEnd,
      algorithm: "KS256",
      delegatedPublicKey,
      requestedTtlSeconds: 3600,
    });
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
    expect(res.ok()).toBeTruthy();
    const issued = decodeCoordinatorDelegationIssue(
      new Uint8Array(await res.body()),
    );
    expect(issued.issuedAt).toBe(materialIssuedAt);
    expect(bytesToBase64(issued.certificate)).toBe(materialCertificateB64);
  });

  test("session GET pending — entry cleared", async ({ request }) => {
    const res = await request.get(
      `${coordinatorUrl}/api/delegations/pending?authLogId=${logUuid}`,
      { headers: sessionAuthHeaders(sessionToken) },
    );
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      entries: Array<{ logIdHex32: string; mmrStart: number; mmrEnd: number }>;
    };
    expect(
      body.entries.some(
        (e) =>
          e.logIdHex32 === logHex32 &&
          e.mmrStart === mmrStart &&
          e.mmrEnd === mmrEnd,
      ),
    ).toBe(false);
  });

  test("session PUT/GET user enabled — two-authority body", async ({
    request,
  }) => {
    const putRes = await request.put(
      `${coordinatorUrl}/api/logs/${logUuid}/enabled`,
      {
        headers: sessionAuthHeaders(sessionToken, {
          "Content-Type": "application/json",
        }),
        data: { enabled: false },
      },
    );
    expect(putRes.status()).toBe(200);
    expect(await putRes.json()).toEqual({
      enabled: false,
      userEnabled: false,
      operatorEnabled: true,
    });

    const getRes = await request.get(
      `${coordinatorUrl}/api/logs/${logUuid}/enabled`,
      { headers: sessionAuthHeaders(sessionToken) },
    );
    expect(getRes.status()).toBe(200);
    expect(await getRes.json()).toEqual({
      enabled: false,
      userEnabled: false,
      operatorEnabled: true,
    });
  });

  test("operator token rejected on session-only GET pending", async ({
    request,
  }) => {
    const res = await request.get(
      `${coordinatorUrl}/api/delegations/pending?authLogId=${logUuid}`,
      { headers: { Authorization: `Bearer ${coordinatorToken}` } },
    );
    expect(res.status()).toBe(401);
  });

  test("wrong KS256 key rejected at session exchange", async ({ request }) => {
    const wrongKey = randomKs256PrivateKeyHex();
    const otherLog = randomUUID();

    const rootRes = await uploadBootstrapKs256PublicRoot({
      coordinatorUrl,
      token: coordinatorToken,
      logId: otherLog,
      address: rootAddress,
    });
    expect(rootRes.status).toBe(200);

    await expect(
      exchangeKs256ControlPlaneSession({
        request,
        coordinatorUrl,
        authLogId: otherLog,
        scopes: ["delegations:read"],
        privateKeyHex: wrongKey,
      }),
    ).rejects.toThrow();
  });
});
