import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildControlPlaneMessage } from "../../src/auth/wallet-challenge/challenge-message.js";
import { bytesToBase64 } from "../../src/encoding.js";
import { normalizeLogIdToHex32 } from "../../src/log-id.js";
import type { WalletChallengeEnvelope } from "../../src/types/wallet-challenge.js";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";
import { generateTestRootKeyPair } from "./byok-material-fixture.js";

const TEST_APP_TOKEN = "test-coordinator-token";

async function exportEs256XY(
  keyPair: CryptoKeyPair,
): Promise<{ x: Uint8Array; y: Uint8Array }> {
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer,
  );
  return { x: raw.slice(1, 33), y: raw.slice(33, 65) };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function signEs256ControlPlaneMessage(
  keyPair: CryptoKeyPair,
  message: string,
): Promise<string> {
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      new TextEncoder().encode(message),
    ),
  );
  return bytesToBase64(signature);
}

async function assertOk(response: Response, step: string): Promise<void> {
  if (!response.ok) {
    throw new Error(
      `${step} returned ${response.status}: ${await response.text()}`,
    );
  }
}

describe("wallet-challenge ES256 auth flow", () => {
  it("challenge → ES256 sign → session → pending with session bearer", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await runEs256WalletChallengeFlow();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("500") && !message.includes("Durable Object")) {
          throw error;
        }
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }, 30_000);

  it("rejects ES256 session when signer does not match registered root", async () => {
    const rootKeyPair = await generateTestRootKeyPair();
    const wrongKeyPair = await generateTestRootKeyPair();
    const logUuid = crypto.randomUUID();
    const { x, y } = await exportEs256XY(rootKeyPair);
    const wrong = await exportEs256XY(wrongKeyPair);

    const rootPost = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/public-root`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_APP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          alg: "ES256",
          x: bytesToBase64(x),
          y: bytesToBase64(y),
        }),
      },
    );
    await assertOk(rootPost, "public-root");

    const challengeRes = await fetchWithDoRetry(
      "http://localhost/api/auth/challenge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authLogId: logUuid,
          scopes: ["delegations:read"],
        }),
      },
    );
    await assertOk(challengeRes, "challenge");
    const challenge = (await challengeRes.json()) as {
      nonce: string;
      authLogId: string;
      scopes: string[];
      issuedAt: number;
      expiresAt: number;
      domain: string;
      coordinatorOrigin: string;
      version: string;
    };

    const envelope: WalletChallengeEnvelope = {
      version: "wcc-1",
      domain: challenge.domain,
      coordinatorOrigin: challenge.coordinatorOrigin,
      authLogId: challenge.authLogId,
      scopes: challenge.scopes as WalletChallengeEnvelope["scopes"],
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    };
    const message = buildControlPlaneMessage(envelope);
    const signature = await signEs256ControlPlaneMessage(wrongKeyPair, message);

    const sessionRes = await fetchWithDoRetry(
      "http://localhost/api/auth/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          envelope,
          signature,
          alg: "ES256",
          publicKeyX: bytesToBase64(wrong.x),
          publicKeyY: bytesToBase64(wrong.y),
        }),
      },
    );
    expect(sessionRes.status).toBe(403);
  });
});

async function runEs256WalletChallengeFlow(): Promise<void> {
  const rootKeyPair = await generateTestRootKeyPair();
  const { x, y } = await exportEs256XY(rootKeyPair);
  const logUuid = crypto.randomUUID();
  normalizeLogIdToHex32(logUuid);

  const rootPost = await fetchWithDoRetry(
    `http://localhost/api/logs/${logUuid}/public-root`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_APP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        alg: "ES256",
        x: bytesToBase64(x),
        y: bytesToBase64(y),
      }),
    },
  );
  await assertOk(rootPost, "public-root");

  const challengeRes = await fetchWithDoRetry(
    "http://localhost/api/auth/challenge",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        authLogId: logUuid,
        scopes: ["delegations:read"],
      }),
    },
  );
  await assertOk(challengeRes, "challenge");
  const challenge = (await challengeRes.json()) as {
    nonce: string;
    authLogId: string;
    scopes: string[];
    issuedAt: number;
    expiresAt: number;
    domain: string;
    coordinatorOrigin: string;
    version: string;
  };

  const envelope: WalletChallengeEnvelope = {
    version: "wcc-1",
    domain: challenge.domain,
    coordinatorOrigin: challenge.coordinatorOrigin,
    authLogId: challenge.authLogId,
    scopes: challenge.scopes as WalletChallengeEnvelope["scopes"],
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  };
  const message = buildControlPlaneMessage(envelope);
  const signature = await signEs256ControlPlaneMessage(rootKeyPair, message);

  const sessionRes = await fetchWithDoRetry(
    "http://localhost/api/auth/session",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        envelope,
        signature,
        alg: "ES256",
        publicKeyX: bytesToBase64(x),
        publicKeyY: bytesToBase64(y),
      }),
    },
  );
  await assertOk(sessionRes, "session");
  const session = (await sessionRes.json()) as { token: string };

  const pendingRes = await fetchWithDoRetry(
    `http://localhost/api/delegations/pending?authLogId=${logUuid}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${session.token}` },
    },
  );
  await assertOk(pendingRes, "pending");
}
