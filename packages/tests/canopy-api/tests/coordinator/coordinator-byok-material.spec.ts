/**
 * BYOK material path: pending miss -> runner-signed delegation material ->
 * successful coordinator issue. This uses coordinator APIs only; the root key
 * is owned by the test runner, not Custodian.
 */

import { randomUUID } from "node:crypto";
import { encode as encodeCbor } from "cbor-x";
import { test, expect } from "@playwright/test";
import {
  assertCoordinatorApiE2eEnv,
  hasCoordinatorApiE2eEnv,
} from "@e2e-utils/coordinator-api-env.js";
import {
  buildByokDelegationMaterial,
  bytesToBase64,
  decodeCoordinatorDelegationIssue,
  generateEphemeralDelegatedPublicKeyCbor,
  generateEs256RootKeyPair,
  hex32ToWireLogId,
  verifyByokDelegationCertificate,
} from "@e2e-utils/coordinator-delegation-helpers.js";
import { normalizeForestrieHexId32 } from "@e2e-utils/forestrie-hex-id.js";

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
  let delegatedPublicKey: Uint8Array;
  let materialCertificate: Uint8Array;
  let materialIssuedAt: number;
  let materialExpiresAt: number;

  test("POST signing-route — mark fresh log wallet-managed", async ({
    request,
  }) => {
    rootKeyPair = await generateEs256RootKeyPair();
    delegatedPublicKey = await generateEphemeralDelegatedPublicKeyCbor();

    const res = await request.post(
      `${coordinatorUrl}/api/logs/${logUuid}/signing-route`,
      {
        headers: {
          Authorization: `Bearer ${coordinatorToken}`,
          "Content-Type": "application/json",
        },
        data: { mode: "wallet" },
      },
    );
    expect(res.status()).toBe(200);
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

    const pending = await request.get(
      `${coordinatorUrl}/api/delegations/pending?authLogId=${logUuid}`,
      {
        headers: { Authorization: `Bearer ${coordinatorToken}` },
      },
    );
    expect(pending.ok()).toBeTruthy();
    const body = (await pending.json()) as {
      entries: Array<{
        logIdHex32: string;
        mmrStart: number;
        mmrEnd: number;
      }>;
    };
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

    const pending = await request.get(
      `${coordinatorUrl}/api/delegations/pending?authLogId=${logUuid}`,
      {
        headers: { Authorization: `Bearer ${coordinatorToken}` },
      },
    );
    expect(pending.ok()).toBeTruthy();
    const body = (await pending.json()) as {
      entries: Array<{ logIdHex32: string; mmrStart: number; mmrEnd: number }>;
    };
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
