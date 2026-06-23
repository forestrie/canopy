/**
 * BYOK public-root: upload runner-owned root, read CBOR trust root, verify
 * delegation material signed by that root.
 */

import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import {
  assertCoordinatorApiE2eEnv,
  hasCoordinatorApiE2eEnv,
} from "@e2e-utils/coordinator-api-env.js";
import {
  buildByokDelegationMaterial,
  bytesToBase64,
  exportEs256RootXy,
  fetchCoordinatorPublicRoot,
  generateEphemeralDelegatedPublicKeyCbor,
  generateEs256RootKeyPair,
  importEs256PublicKeyFromXy,
  uploadByokRootPublicKey,
  verifyByokDelegationCertificate,
} from "@e2e-utils/coordinator-delegation-helpers.js";
import { normalizeForestrieHexId32 } from "@e2e-utils/forestrie-hex-id.js";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  if (!hasCoordinatorApiE2eEnv()) {
    throw new Error(
      "Coordinator BYOK public-root e2e requires DELEGATION_COORDINATOR_URL and COORDINATOR_APP_TOKEN.",
    );
  }
});

test.describe("delegation-coordinator BYOK public-root", () => {
  const { baseUrl: coordinatorUrl, appToken: coordinatorToken } =
    assertCoordinatorApiE2eEnv();

  const logUuid = randomUUID();
  const logHex32 = normalizeForestrieHexId32(logUuid);
  const mmrStart = 0;
  const mmrEnd = 128;

  let rootKeyPair: CryptoKeyPair;
  let rootX: Uint8Array;
  let rootY: Uint8Array;
  let delegatedPublicKey: Uint8Array;
  let materialCertificate: Uint8Array;

  test("POST public-root — store runner ES256 root", async () => {
    rootKeyPair = await generateEs256RootKeyPair();
    ({ x: rootX, y: rootY } = await exportEs256RootXy(rootKeyPair));
    delegatedPublicKey = await generateEphemeralDelegatedPublicKeyCbor();

    const res = await uploadByokRootPublicKey({
      coordinatorUrl,
      token: coordinatorToken,
      logId: logUuid,
      x: rootX,
      y: rootY,
    });
    expect(res.status).toBe(200);
  });

  test("GET public-root — CBOR trust root matches upload", async () => {
    const trustRoot = await fetchCoordinatorPublicRoot({
      coordinatorUrl,
      token: coordinatorToken,
      logId: logUuid,
    });
    expect(trustRoot.alg).toBe("ES256");
    expect(trustRoot.logId.byteLength).toBe(16);
    expect(bytesToBase64(trustRoot.x)).toBe(bytesToBase64(rootX));
    expect(bytesToBase64(trustRoot.y)).toBe(bytesToBase64(rootY));

    const rehydrated = await importEs256PublicKeyFromXy(
      trustRoot.x,
      trustRoot.y,
    );
    const material = await buildByokDelegationMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart,
      mmrEnd,
      delegatedPublicKey,
    });
    materialCertificate = material.certificate;
    expect(
      await verifyByokDelegationCertificate({
        certificate: materialCertificate,
        rootPublicKey: rehydrated,
      }),
    ).toBe(true);
  });

  test("POST material — cert verifies against coordinator public-root", async ({
    request,
  }) => {
    const material = await buildByokDelegationMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart,
      mmrEnd,
      delegatedPublicKey,
    });

    const res = await request.post(
      `${coordinatorUrl}/api/delegations/certificate`,
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
          certificate: bytesToBase64(material.certificate),
          issuedAt: material.issuedAt,
          expiresAt: material.expiresAt,
        },
      },
    );
    expect(res.status()).toBe(200);

    const trustRoot = await fetchCoordinatorPublicRoot({
      coordinatorUrl,
      token: coordinatorToken,
      logId: logUuid,
    });
    const rehydrated = await importEs256PublicKeyFromXy(
      trustRoot.x,
      trustRoot.y,
    );
    expect(
      await verifyByokDelegationCertificate({
        certificate: material.certificate,
        rootPublicKey: rehydrated,
      }),
    ).toBe(true);
  });
});

test.describe("delegation-coordinator BYOK public-root negatives", () => {
  const { baseUrl: coordinatorUrl, appToken: coordinatorToken } =
    assertCoordinatorApiE2eEnv();

  test("GET public-root without upload returns 404 problem+cbor", async ({
    request,
  }) => {
    const freshLog = randomUUID();
    const res = await request.get(
      `${coordinatorUrl}/api/logs/${freshLog}/public-root`,
      {
        headers: {
          Accept: "application/cbor",
        },
      },
    );
    expect(res.status()).toBe(404);
    expect(res.headers()["content-type"] ?? "").toContain(
      "application/problem+cbor",
    );
  });

  test("POST public-root rejects short x with 400 problem+json", async ({
    request,
  }) => {
    const freshLog = randomUUID();
    const shortX = Buffer.from(new Uint8Array(16).fill(1)).toString("base64");
    const y = bytesToBase64(new Uint8Array(32).fill(2));
    const res = await request.post(
      `${coordinatorUrl}/api/logs/${freshLog}/public-root`,
      {
        headers: {
          Authorization: `Bearer ${coordinatorToken}`,
          "Content-Type": "application/json",
        },
        data: { alg: "ES256", x: shortX, y },
      },
    );
    expect(res.status()).toBe(400);
    expect(res.headers()["content-type"] ?? "").toContain(
      "application/problem+json",
    );
  });
});
