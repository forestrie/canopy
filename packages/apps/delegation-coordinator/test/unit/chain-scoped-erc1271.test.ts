/**
 * Chain-scoped ERC-1271 verification (plan-2607-46 slice 03): RPC is
 * selected by the log's chain binding (public_roots.chain_id, carried on
 * the public-root POST) and eth_chainId-asserted; the signed-but-previously-
 * unchecked envelope chainId is enforced; a contract root with no
 * resolvable binding fails closed.
 */

import { randomUUID } from "node:crypto";
import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { decodeCborStruct } from "../../src/cbor.js";
import { buildKs256ControlPlaneMessage } from "../../src/auth/wallet-challenge/challenge-message.js";
import { normalizeLogIdToHex32 } from "../../src/log-id.js";
import type { TrustRootResponseCbor } from "../../src/types/trust-root-response.js";
import type { WalletChallengeEnvelope } from "../../src/types/wallet-challenge.js";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";

const TEST_APP_TOKEN = "test-coordinator-token";
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const COSE_ALG_KS256 = -65799;
const MAGIC_WORD = `0x1626ba7e${"0".repeat(56)}`;
const CONTRACT_CODE = "0x600160005260206000f3";
const SAFE_SIGNATURE = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
/** Test var maps 84532 → https://rpc.test (wrangler.jsonc). */
const CHAIN_ID = "84532";
const CHAIN_ID_HEX = "0x14a34";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function addressKeyB64(fill: number): string {
  return bytesToBase64(new Uint8Array(20).fill(fill));
}

function eoaKeyB64(address: `0x${string}`): string {
  const hex = address.slice(2);
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytesToBase64(out);
}

async function postPublicRoot(
  logUuid: string,
  keyB64: string,
  chainBinding?: { chainId: string },
): Promise<Response> {
  return fetchWithDoRetry(`http://localhost/api/logs/${logUuid}/public-root`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TEST_APP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      alg: COSE_ALG_KS256,
      key: keyB64,
      ...(chainBinding ? { chainBinding } : {}),
    }),
  });
}

async function challengeEnvelope(
  logUuid: string,
  chainId?: string,
): Promise<WalletChallengeEnvelope> {
  const res = await fetchWithDoRetry("http://localhost/api/auth/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authLogId: logUuid, scopes: ["delegations:read"] }),
  });
  expect(res.status).toBe(200);
  const challenge = (await res.json()) as WalletChallengeEnvelope & {
    version: string;
  };
  return {
    version: "wcc-1",
    domain: challenge.domain,
    coordinatorOrigin: challenge.coordinatorOrigin,
    authLogId: challenge.authLogId,
    scopes: challenge.scopes,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    ...(chainId ? { chainId } : {}),
  };
}

async function exchangeSession(
  envelope: WalletChallengeEnvelope,
  signature: string,
): Promise<Response> {
  return fetchWithDoRetry("http://localhost/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envelope, signature, alg: "KS256" }),
  });
}

/** Intercept https://rpc.test, answering per JSON-RPC method. */
function stubChainRpc(answers: {
  chainId?: string;
  code?: string;
  call?: string;
}): void {
  fetchMock
    .get("https://rpc.test")
    .intercept({ path: "/", method: "POST" })
    .reply(200, (opts) => {
      const body = JSON.parse(String(opts.body)) as {
        id: number;
        method: string;
      };
      const result =
        body.method === "eth_chainId"
          ? (answers.chainId ?? CHAIN_ID_HEX)
          : body.method === "eth_getCode"
            ? (answers.code ?? CONTRACT_CODE)
            : (answers.call ?? MAGIC_WORD);
      return JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    })
    .persist();
}

describe("chain-scoped ERC-1271 (plan-2607-46 slice 03)", () => {
  beforeAll(() => {
    fetchMock.activate();
  });
  afterEach(() => {
    fetchMock.deactivate();
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it("public-root chainBinding round-trips into the trust-root response", async () => {
    const logUuid = randomUUID();
    const posted = await postPublicRoot(logUuid, addressKeyB64(0x5a), {
      chainId: CHAIN_ID,
    });
    expect(posted.status).toBe(200);

    const got = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/public-root`,
    );
    expect(got.status).toBe(200);
    const decoded = decodeCborStruct<TrustRootResponseCbor>(
      new Uint8Array(await got.arrayBuffer()),
    );
    expect(decoded.chainId).toBe(CHAIN_ID);
  });

  it("contract root with a chain binding authenticates via chain-asserted ERC-1271", async () => {
    stubChainRpc({});
    const logUuid = randomUUID();
    await postPublicRoot(logUuid, addressKeyB64(0x5b), { chainId: CHAIN_ID });

    const envelope = await challengeEnvelope(logUuid, CHAIN_ID);
    const session = await exchangeSession(envelope, SAFE_SIGNATURE);
    expect(session.status).toBe(200);
    const body = (await session.json()) as { token?: string };
    expect(body.token?.length).toBeGreaterThan(0);
  });

  it("rejects an envelope chainId that disagrees with the log's binding", async () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const logUuid = randomUUID();
    await postPublicRoot(logUuid, eoaKeyB64(account.address), {
      chainId: CHAIN_ID,
    });

    // Signed over the WRONG chain id: the mismatch must 403 before any
    // signature verdict is even attempted.
    const envelope = await challengeEnvelope(logUuid, "1");
    const signature = await account.signMessage({
      message: buildKs256ControlPlaneMessage(envelope),
    });
    const session = await exchangeSession(envelope, signature);
    expect(session.status).toBe(403);
    const problem = (await session.json()) as { detail?: string };
    expect(problem.detail).toMatch(/chain/i);
  });

  it("contract root with no resolvable chain binding fails closed", async () => {
    const logUuid = randomUUID();
    await postPublicRoot(logUuid, addressKeyB64(0x5c));

    const envelope = await challengeEnvelope(logUuid);
    const session = await exchangeSession(envelope, SAFE_SIGNATURE);
    // No hooks without a binding: the Safe blob falls through to (failing)
    // EOA recovery — a 401 verdict, never a session, and no RPC consulted.
    expect(session.status).toBe(401);
  });

  it("an RPC serving the wrong chain is 503 unavailable, never a verdict", async () => {
    // Distinct endpoint (chain 31337 → rpc-wrongserve.test in the test var):
    // endpoint chain ids are memoized per isolate, so the shared rpc.test
    // memo from earlier specs must not leak into this one.
    fetchMock
      .get("https://rpc-wrongserve.test")
      .intercept({ path: "/", method: "POST" })
      .reply(200, (opts) => {
        const body = JSON.parse(String(opts.body)) as { id: number };
        return JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x1" });
      })
      .persist();
    const logUuid = randomUUID();
    await postPublicRoot(logUuid, addressKeyB64(0x5d), { chainId: "31337" });

    const envelope = await challengeEnvelope(logUuid, "31337");
    const session = await exchangeSession(envelope, SAFE_SIGNATURE);
    expect(session.status).toBe(503);
  });

  it("legacy binding fallback: instance-bound log resolves its chain", async () => {
    stubChainRpc({});
    const logUuid = randomUUID();
    const logHex = normalizeLogIdToHex32(logUuid);
    // Root registered WITHOUT chainBinding (legacy shape)…
    await postPublicRoot(logUuid, addressKeyB64(0x5e));
    // …but the log carries an instance binding, whose CAIP id names the chain.
    const bind = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/webhook`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TEST_APP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          univocityInstanceId: `eip155:${CHAIN_ID}:0x${"ab".repeat(20)}`,
        }),
      },
    );
    expect(bind.status).toBe(200);

    const envelope = await challengeEnvelope(logUuid, CHAIN_ID);
    const session = await exchangeSession(envelope, SAFE_SIGNATURE);
    expect(session.status).toBe(200);
    void logHex;
  });
});

describe("public-root chain_id COALESCE (plan-2607-10 L4)", () => {
  it("a re-PUT without chainBinding keeps the stored chain; a new one overwrites", async () => {
    const logUuid = randomUUID();
    await postPublicRoot(logUuid, addressKeyB64(0x6a), { chainId: CHAIN_ID });

    // Legacy/version-skew writer omits the binding: chain_id must survive.
    await postPublicRoot(logUuid, addressKeyB64(0x6a));
    let got = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/public-root`,
    );
    let decoded = decodeCborStruct<TrustRootResponseCbor>(
      new Uint8Array(await got.arrayBuffer()),
    );
    expect(decoded.chainId).toBe(CHAIN_ID);

    // An explicit non-null binding corrects it.
    await postPublicRoot(logUuid, addressKeyB64(0x6a), { chainId: "31337" });
    got = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/public-root`,
    );
    decoded = decodeCborStruct<TrustRootResponseCbor>(
      new Uint8Array(await got.arrayBuffer()),
    );
    expect(decoded.chainId).toBe("31337");
  });
});
