/**
 * BYOK material path: pending miss -> runner-signed delegation material ->
 * successful coordinator issue. This uses coordinator APIs only; the root key
 * is owned by the test runner, not Custodian.
 */

import { randomUUID } from "node:crypto";
import { encodeCborDeterministic as encodeCbor } from "@forestrie/encoding";
import { test, expect } from "@playwright/test";
import {
  assertCoordinatorApiE2eEnv,
  hasCoordinatorApiE2eEnv,
} from "@e2e-utils/coordinator-api-env.js";
import {
  buildByokDelegationMaterial,
  bytesToBase64,
  decodeCoordinatorDelegationIssue,
  exportEs256RootXy,
  fetchLogPendingDelegation,
  generateEphemeralDelegatedPublicKeyCbor,
  generateEs256RootKeyPair,
  hex32ToWireLogId,
  uploadByokRootPublicKey,
  verifyByokDelegationCertificate,
} from "@e2e-utils/coordinator-delegation-helpers.js";
import { normalizeForestrieHexId32 } from "@e2e-utils/forestrie-hex-id.js";
import {
  exchangeEs256ControlPlaneSession,
  postSigningRouteWithSession,
  WALLET_CHALLENGE_ES256_SCOPES,
} from "@e2e-utils/wallet-challenge-session-e2e.js";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  if (!hasCoordinatorApiE2eEnv()) {
    throw new Error(
      "Coordinator BYOK e2e requires DELEGATION_COORDINATOR_URL and COORDINATOR_APP_TOKEN.",
    );
  }
});

test.describe("delegation-coordinator BYOK material", () => {
  const { baseUrl: coordinatorUrl, appToken: coordinatorToken } =
    assertCoordinatorApiE2eEnv();

  const logUuid = randomUUID();
  const logHex32 = normalizeForestrieHexId32(logUuid);
  const mmrStart = 2;
  const mmrEnd = 64;

  let rootKeyPair: CryptoKeyPair;
  let rootX: Uint8Array;
  let rootY: Uint8Array;
  let delegatedPublicKey: Uint8Array;
  let materialCertificate: Uint8Array;
  let materialIssuedAt: number;
  let materialExpiresAt: number;

  test("POST public-root — mark fresh log wallet-managed", async () => {
    rootKeyPair = await generateEs256RootKeyPair();
    ({ x: rootX, y: rootY } = await exportEs256RootXy(rootKeyPair));
    delegatedPublicKey = await generateEphemeralDelegatedPublicKeyCbor();

    const rootRes = await uploadByokRootPublicKey({
      coordinatorUrl,
      token: coordinatorToken,
      logId: logUuid,
      x: rootX,
      y: rootY,
    });
    expect(rootRes.status).toBe(200);
  });

  test("POST signing-route — wallet-managed via ES256 session", async ({
    request,
  }) => {
    const session = await exchangeEs256ControlPlaneSession({
      request,
      coordinatorUrl,
      authLogId: logUuid,
      scopes: WALLET_CHALLENGE_ES256_SCOPES,
      rootKeyPair,
    });
    await postSigningRouteWithSession({
      request,
      coordinatorUrl,
      logId: logUuid,
      sessionToken: session.token,
      mode: "wallet",
    });
  });

  test("POST /api/delegations — miss creates pending entry", async ({
    request,
  }) => {
    const res = await request.post(`${coordinatorUrl}/api/delegations`, {
      headers: {
        Authorization: `Bearer ${coordinatorToken}`,
        "Content-Type": "application/cbor",
        Accept: "application/cbor",
      },
      data: issueBody(),
    });
    expect(res.status()).toBe(202);

    const body = await fetchLogPendingDelegation({
      request,
      coordinatorUrl,
      logId: logUuid,
    });
    expect(
      body.entries.some(
        (entry) =>
          entry.logIdHex32 === logHex32 &&
          entry.mmrStart === mmrStart &&
          entry.mmrEnd === mmrEnd,
      ),
    ).toBe(true);
  });

  test("POST material — store runner-signed BYOK certificate", async ({
    request,
  }) => {
    const material = await buildByokDelegationMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart,
      mmrEnd,
      delegatedPublicKey,
    });
    materialCertificate = material.certificate;
    materialIssuedAt = material.issuedAt;
    materialExpiresAt = material.expiresAt;

    const verified = await verifyByokDelegationCertificate({
      certificate: materialCertificate,
      rootPublicKey: rootKeyPair.publicKey,
    });
    expect(verified).toBe(true);

    const res = await request.post(
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
          certificate: bytesToBase64(materialCertificate),
          issuedAt: materialIssuedAt,
          expiresAt: materialExpiresAt,
        },
      },
    );
    expect(res.status()).toBe(200);
  });

  test("POST /api/delegations — returns BYOK material and clears pending", async ({
    request,
  }) => {
    const res = await request.post(`${coordinatorUrl}/api/delegations`, {
      headers: {
        Authorization: `Bearer ${coordinatorToken}`,
        "Content-Type": "application/cbor",
        Accept: "application/cbor",
      },
      data: issueBody(),
    });
    expect(res.ok()).toBeTruthy();
    const issued = decodeCoordinatorDelegationIssue(
      new Uint8Array(await res.body()),
    );
    expect(issued.issuedAt).toBe(materialIssuedAt);
    expect(issued.expiresAt).toBe(materialExpiresAt);
    expect(bytesToBase64(issued.certificate)).toBe(
      bytesToBase64(materialCertificate),
    );
    expect(
      await verifyByokDelegationCertificate({
        certificate: issued.certificate,
        rootPublicKey: rootKeyPair.publicKey,
      }),
    ).toBe(true);

    const body = await fetchLogPendingDelegation({
      request,
      coordinatorUrl,
      logId: logUuid,
    });
    expect(
      body.entries.some(
        (entry) =>
          entry.logIdHex32 === logHex32 &&
          entry.mmrStart === mmrStart &&
          entry.mmrEnd === mmrEnd,
      ),
    ).toBe(false);
  });

  function issueBody(): Buffer {
    const encoded = encodeCbor({
      version: 1,
      domain: "forestrie.test.delegation",
      chainId: "31337",
      contractAddress: "0x0000000000000000000000000000000000000001",
      logId: hex32ToWireLogId(logHex32),
      mmrStart,
      mmrEnd,
      algorithm: "ES256",
      delegatedPublicKey,
      requestedTtlSeconds: 3600,
    });
    const u8 =
      encoded instanceof Uint8Array
        ? encoded
        : new Uint8Array(encoded as ArrayLike<number>);
    return Buffer.from(u8);
  }
});
