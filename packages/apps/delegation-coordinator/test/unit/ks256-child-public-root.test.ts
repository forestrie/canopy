/**
 * KS256 child public roots (plan-2610-03 D2; devdocs ADR-0053 amendment
 * 2026-10-18).
 *
 * Proves canopy-api can forward a KS256 child root as `{ alg: -65799, key,
 * chainBinding }` to `POST /api/logs/{id}/public-root` and the coordinator
 * needs no code change: it stores the 20-byte address with its chain binding
 * and serves it back (store lookup and CBOR GET). An ES256 root with a chain
 * binding and a key whose length disagrees with `alg` are covered alongside.
 */

import { randomUUID } from "node:crypto";
import { decodeCborDeterministic } from "@forestrie/encoding";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { loadRegisteredPublicRoot } from "../../src/auth/wallet-challenge/public-root-match.js";
import { bytesToBase64 } from "../../src/encoding.js";
import { normalizeLogIdToHex32 } from "../../src/log-id.js";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";

const TEST_TOKEN = "test-coordinator-token";
const COSE_ALG_KS256 = -65799;
const CHAIN_ID = "84532";

function authHeaders(extra?: HeadersInit): HeadersInit {
  return { Authorization: `Bearer ${TEST_TOKEN}`, ...extra };
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Register a child public root — the call canopy-api forwards. */
async function postPublicRoot(
  logUuid: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetchWithDoRetry(`http://localhost/api/logs/${logUuid}/public-root`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("KS256 child public root with chain binding", () => {
  it("accepts alg -65799 + chainBinding and reads it back", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const addr = randomBytes(20);

    const postRes = await postPublicRoot(logUuid, {
      alg: COSE_ALG_KS256,
      key: bytesToBase64(addr),
      chainBinding: {
        chainId: CHAIN_ID,
        univocityAddr: hexOf(randomBytes(20)),
      },
    });
    expect(postRes.status).toBe(200);

    const root = await loadRegisteredPublicRoot(env, logHex32);
    expect(root).toEqual({ alg: "KS256", key: addr, chainId: CHAIN_ID });

    const getRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/public-root`,
      {
        method: "GET",
        headers: authHeaders({ Accept: "application/cbor" }),
      },
    );
    expect(getRes.status).toBe(200);
    const decoded = Object.fromEntries(
      decodeCborDeterministic(
        new Uint8Array(await getRes.arrayBuffer()),
      ) as Map<string, unknown>,
    );
    expect(decoded.alg).toBe(COSE_ALG_KS256);
    expect(decoded.key).toEqual(addr);
    expect(decoded.chainId).toBe(CHAIN_ID);
  });

  it("accepts a chainBinding with only chainId", async () => {
    const logUuid = randomUUID();
    const addr = randomBytes(20);

    const postRes = await postPublicRoot(logUuid, {
      alg: COSE_ALG_KS256,
      key: bytesToBase64(addr),
      chainBinding: { chainId: CHAIN_ID },
    });
    expect(postRes.status).toBe(200);

    const root = await loadRegisteredPublicRoot(
      env,
      normalizeLogIdToHex32(logUuid),
    );
    expect(root).toEqual({ alg: "KS256", key: addr, chainId: CHAIN_ID });
  });

  it("accepts an ES256 root with a chainBinding", async () => {
    const logUuid = randomUUID();
    const x = randomBytes(32);
    const y = randomBytes(32);

    const postRes = await postPublicRoot(logUuid, {
      alg: "ES256",
      x: bytesToBase64(x),
      y: bytesToBase64(y),
      chainBinding: {
        chainId: CHAIN_ID,
        univocityAddr: hexOf(randomBytes(20)),
      },
    });
    expect(postRes.status).toBe(200);

    const root = await loadRegisteredPublicRoot(
      env,
      normalizeLogIdToHex32(logUuid),
    );
    expect(root).toEqual({ alg: "ES256", x, y, chainId: CHAIN_ID });
  });

  it("rejects a KS256 key whose length is not 20 bytes", async () => {
    const postRes = await postPublicRoot(randomUUID(), {
      alg: COSE_ALG_KS256,
      key: bytesToBase64(randomBytes(64)),
    });
    expect(postRes.status).toBe(400);
  });
});
