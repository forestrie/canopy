/**
 * Log authority reader: canopy-api's only source of a log's root key and of
 * whether it is anchored (devdocs ADR-0075 decision 5, protocol ADR-0070).
 * These tests stub univocity's `GET /api/logs/{logId}/authority` with `fetch`
 * and use a private Cache API cache, so they see exactly when univocity is
 * called and what is cached.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeCborDeterministic } from "@forestrie/encoding";
import {
  authorityCacheKey,
  createUnivocityLogAuthorityReader,
} from "../src/env/log-authority-reader.js";

const SERVICE_URL = "https://univocity.test";
const ANCHORED_CACHE_SECONDS = 30;

afterEach(() => {
  vi.restoreAllMocks();
});

function randomLogId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

function uuidOf(b: Uint8Array): string {
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** univocity's authority answer, as its CBOR fields. */
type Answer = Record<string, unknown>;

function anchored(final: boolean): Answer {
  return {
    state: "anchored",
    alg: -7,
    key: new Uint8Array(64).fill(7),
    chainId: "84532",
    final,
  };
}

/**
 * Stubs univocity: answers each authority read with the next answer queued for
 * that log (repeating the last), or with `status` when no body is queued.
 */
function stubUnivocity(answers: Map<string, Array<Answer | number>>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const m = /\/api\/logs\/([^/]+)\/authority$/.exec(new URL(url).pathname);
    const queue = m ? answers.get(m[1]!) : undefined;
    if (!queue || queue.length === 0) return new Response("", { status: 404 });
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (typeof next === "number") return new Response("", { status: next });
    return new Response(encodeCborDeterministic(next) as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": "application/cbor" },
    });
  });
}

async function privateCache(): Promise<Cache> {
  return caches.open(`log-authority-${crypto.randomUUID()}`);
}

describe("createUnivocityLogAuthorityReader", () => {
  it("serves a final answer from the cache without calling univocity", async () => {
    const logId = randomLogId();
    const fetchSpy = stubUnivocity(
      new Map([[uuidOf(logId), [anchored(true)]]]),
    );
    const reader = createUnivocityLogAuthorityReader({
      serviceUrl: SERVICE_URL,
      anchoredCacheSeconds: ANCHORED_CACHE_SECONDS,
      cache: await privateCache(),
    });

    const first = await reader.read(logId);
    const second = await reader.read(logId);

    expect(first.kind).toBe("anchored");
    expect(second).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0]! as [string];
    expect(url).toBe(`${SERVICE_URL}/api/logs/${uuidOf(logId)}/authority`);
  });

  it("a new cache generation does not serve a final answer an older one cached, so a lane reset can reuse log ids", async () => {
    const logId = randomLogId();
    const fetchSpy = stubUnivocity(
      new Map([[uuidOf(logId), [anchored(true)]]]),
    );
    const cache = await privateCache();
    const reader = (cacheGeneration: string) =>
      createUnivocityLogAuthorityReader({
        serviceUrl: SERVICE_URL,
        anchoredCacheSeconds: ANCHORED_CACHE_SECONDS,
        cacheGeneration,
        cache,
      });

    await reader("before-reset").read(logId);
    await reader("before-reset").read(logId);
    expect(fetchSpy).toHaveBeenCalledOnce();

    await reader("after-reset").read(logId);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("ignores a cached entry canopy did not write, and asks univocity", async () => {
    const logId = randomLogId();
    const cache = await privateCache();
    // Something else (an HTTP cache, say) left an anchored answer under the
    // reader's own key, without canopy's freshness header.
    await cache.put(
      authorityCacheKey(SERVICE_URL, logId, "g1"),
      new Response(
        encodeCborDeterministic(anchored(true)) as unknown as BodyInit,
        {
          headers: {
            "content-type": "application/cbor",
            "cache-control": "max-age=600",
          },
        },
      ),
    );
    const fetchSpy = stubUnivocity(new Map([[uuidOf(logId), [503]]]));
    const reader = createUnivocityLogAuthorityReader({
      serviceUrl: SERVICE_URL,
      anchoredCacheSeconds: ANCHORED_CACHE_SECONDS,
      cacheGeneration: "g1",
      cache,
    });

    expect((await reader.read(logId)).kind).toBe("unavailable");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("treats a cached answer it cannot decode as a miss, not an error", async () => {
    const logId = randomLogId();
    const cache = await privateCache();
    await cache.put(
      authorityCacheKey(SERVICE_URL, logId, "g1"),
      new Response("not cbor", {
        headers: {
          "content-type": "application/cbor",
          "cache-control": "max-age=600",
          "x-canopy-fresh-until": String(Date.now() + 600_000),
        },
      }),
    );
    const fetchSpy = stubUnivocity(
      new Map([[uuidOf(logId), [anchored(true)]]]),
    );
    const reader = createUnivocityLogAuthorityReader({
      serviceUrl: SERVICE_URL,
      anchoredCacheSeconds: ANCHORED_CACHE_SECONDS,
      cacheGeneration: "g1",
      cache,
    });

    expect((await reader.read(logId)).kind).toBe("anchored");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("re-reads an anchored answer that is not final once its cache time passes, so a conflict takes effect", async () => {
    const logId = randomLogId();
    const fetchSpy = stubUnivocity(
      new Map<string, Array<Answer | number>>([
        [
          uuidOf(logId),
          [anchored(false), { state: "conflicted", final: true }],
        ],
      ]),
    );
    let nowMs = 1_000_000;
    const reader = createUnivocityLogAuthorityReader({
      serviceUrl: SERVICE_URL,
      anchoredCacheSeconds: ANCHORED_CACHE_SECONDS,
      cache: await privateCache(),
      now: () => nowMs,
    });

    expect((await reader.read(logId)).kind).toBe("anchored");
    nowMs += (ANCHORED_CACHE_SECONDS - 1) * 1000;
    expect((await reader.read(logId)).kind).toBe("anchored");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    nowMs += 2 * 1000;
    expect((await reader.read(logId)).kind).toBe("conflicted");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("never caches a pending answer, and reports its state, blockedBy and expiresAt", async () => {
    const logId = randomLogId();
    const owner = randomLogId();
    const fetchSpy = stubUnivocity(
      new Map<string, Array<Answer | number>>([
        [
          uuidOf(logId),
          [
            {
              state: "reserved",
              blockedBy: owner,
              expiresAt: 1_900_000_000,
              final: false,
            },
            anchored(true),
          ],
        ],
      ]),
    );
    const reader = createUnivocityLogAuthorityReader({
      serviceUrl: SERVICE_URL,
      anchoredCacheSeconds: ANCHORED_CACHE_SECONDS,
      cache: await privateCache(),
    });

    expect(await reader.read(logId)).toEqual({
      kind: "pending",
      state: "reserved",
      blockedBy: owner,
      expiresAt: 1_900_000_000,
    });
    expect((await reader.read(logId)).kind).toBe("anchored");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("treats a final answer with blockedBy as conflicted: the ancestor never anchors", async () => {
    const logId = randomLogId();
    const ancestor = randomLogId();
    const fetchSpy = stubUnivocity(
      new Map<string, Array<Answer | number>>([
        [
          uuidOf(logId),
          [{ ...anchored(true), blockedBy: ancestor }, anchored(true)],
        ],
      ]),
    );
    const reader = createUnivocityLogAuthorityReader({
      serviceUrl: SERVICE_URL,
      anchoredCacheSeconds: ANCHORED_CACHE_SECONDS,
      cache: await privateCache(),
    });

    expect(await reader.read(logId)).toEqual({
      kind: "conflicted",
      blockedBy: ancestor,
    });
    expect((await reader.read(logId)).kind).toBe("conflicted");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("is anchored but pending while an ancestor that is not final blocks it", async () => {
    const logId = randomLogId();
    const ancestor = randomLogId();
    stubUnivocity(
      new Map<string, Array<Answer | number>>([
        [uuidOf(logId), [{ ...anchored(false), blockedBy: ancestor }]],
      ]),
    );
    const reader = createUnivocityLogAuthorityReader({
      serviceUrl: SERVICE_URL,
      anchoredCacheSeconds: ANCHORED_CACHE_SECONDS,
      cache: await privateCache(),
    });

    expect(await reader.read(logId)).toEqual({
      kind: "pending",
      state: "anchored",
      blockedBy: ancestor,
      chainId: "84532",
    });
  });

  it("reports unavailable when univocity fails and nothing is cached, and unclaimed on 404", async () => {
    const down = randomLogId();
    const unknown = randomLogId();
    stubUnivocity(
      new Map<string, Array<Answer | number>>([[uuidOf(down), [503]]]),
    );
    const reader = createUnivocityLogAuthorityReader({
      serviceUrl: SERVICE_URL,
      anchoredCacheSeconds: ANCHORED_CACHE_SECONDS,
      cache: await privateCache(),
    });

    expect((await reader.read(down)).kind).toBe("unavailable");
    expect(await reader.read(unknown)).toEqual({ kind: "unclaimed" });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect"));
    expect((await reader.read(down)).kind).toBe("unavailable");
  });
});
