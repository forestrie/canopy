import { SELF } from "cloudflare:test";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { buildKs256ControlPlaneMessage } from "../../src/auth/wallet-challenge/challenge-message.js";
import { scopeAllows } from "../../src/auth/wallet-challenge/scopes.js";
import {
  mintSessionToken,
  verifySessionToken,
} from "../../src/auth/wallet-challenge/session-token.js";
import { bytesToBase64 } from "../../src/encoding.js";
import { normalizeLogIdToHex32 } from "../../src/log-id.js";
import { COSE_ALG_KS256 } from "../../src/types/trust-root-response.js";
import type { WalletChallengeEnvelope } from "../../src/types/wallet-challenge.js";

const TEST_APP_TOKEN = "test-coordinator-token";
const SESSION_SECRET = "test-wallet-challenge-secret";
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const logUuid = "01234567-89ab-cdef-0123-456789abcdef";
const logHex32 = normalizeLogIdToHex32(logUuid);

async function fetchWithDoRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await SELF.fetch(input, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("invalidating this Durable Object")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return SELF.fetch(input, init);
}

function addressToRootKey(address: `0x${string}`): string {
  const hex = address.slice(2);
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytesToBase64(bytes);
}

describe("wallet-challenge session token", () => {
  it("mints and verifies a control-plane session", () => {
    const { token, claims } = mintSessionToken(
      {
        authLogId: logHex32,
        scopes: ["delegations:read"],
        aud: "http://localhost",
      },
      SESSION_SECRET,
    );
    const verified = verifySessionToken(token, SESSION_SECRET);
    expect(verified).toEqual(claims);
  });

  it("rejects expired sessions", () => {
    const { token } = mintSessionToken(
      {
        authLogId: logHex32,
        scopes: ["delegations:read"],
        aud: "http://localhost",
        exp: 1,
      },
      SESSION_SECRET,
      100,
    );
    expect(verifySessionToken(token, SESSION_SECRET, 200)).toBeNull();
  });

  it("rejects sessions when aud does not match expected coordinator origin", () => {
    const { token } = mintSessionToken(
      {
        authLogId: logHex32,
        scopes: ["delegations:read"],
        aud: "https://evil.example",
      },
      SESSION_SECRET,
    );
    expect(
      verifySessionToken(token, SESSION_SECRET, undefined, "http://localhost"),
    ).toBeNull();
    expect(
      verifySessionToken(
        token,
        SESSION_SECRET,
        undefined,
        "https://evil.example",
      ),
    ).not.toBeNull();
  });
});

describe("wallet-challenge scopes", () => {
  it("allows exact scope match", () => {
    expect(scopeAllows(["delegations:read"], "delegations:read")).toBe(true);
  });

  it("denies missing scope", () => {
    expect(scopeAllows(["delegations:read"], "logs:enabled:write")).toBe(false);
  });
});

describe("wallet-challenge auth flow", () => {
  it("challenge → sign → session → pending with session bearer", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await runWalletChallengeFlow();
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
});

async function assertOk(response: Response, step: string): Promise<void> {
  if (!response.ok) {
    throw new Error(
      `${step} returned ${response.status}: ${await response.text()}`,
    );
  }
}

async function runWalletChallengeFlow(): Promise<void> {
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  const logUuid = crypto.randomUUID();

  const rootPost = await fetchWithDoRetry(
    `http://localhost/api/logs/${logUuid}/public-root`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_APP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        alg: COSE_ALG_KS256,
        key: addressToRootKey(account.address),
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
  const message = buildKs256ControlPlaneMessage(envelope);
  const signature = await account.signMessage({ message });

  const sessionRes = await fetchWithDoRetry(
    "http://localhost/api/auth/session",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelope, signature, alg: "KS256" }),
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
