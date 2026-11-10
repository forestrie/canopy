/**
 * Reads a log's authority from univocity
 * (`GET /api/logs/{logId}/authority`, arbor `services/univocity`), through the
 * edge cache. Admission ({@link refuseUnlessAnchored}) and receipt verification
 * both read it, so canopy-api has one source of root keys and never falls back
 * to Custodian or the delegation coordinator
 * ([devdocs ADR-0075](https://github.com/forestrie/devdocs/blob/main/adr/adr-0075-sec-child-root-claimed-once.md)
 * decision 5).
 *
 * Caching follows from what can still change. A final answer (anchored and
 * compared with the chain, or conflicted) is cached without expiry. An
 * anchored answer that is not final is cached for a short configured time, so
 * a conflict found at the log's first checkpoint takes effect promptly. A
 * pending answer is never cached: it changes when the owner next publishes.
 */

import { decodeCborDeterministic } from "@forestrie/encoding";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import {
  AUTHORITY_STATE_ANCHORED,
  AUTHORITY_STATE_CONFLICTED,
  type LogAuthority,
} from "./log-authority.js";

/** Reads a log's authority; the seam admission and receipt verification use. */
export interface LogAuthorityReader {
  /** @param logId 16-byte log id. Never throws; an outage is `unavailable`. */
  read(logId: Uint8Array): Promise<LogAuthority>;
}

/** A cached final answer is kept for a year: in effect, without expiry. */
const FINAL_CACHE_SECONDS = 31_536_000;

/**
 * Header on a cached entry holding the unix ms after which it is stale. The
 * reader checks it as well as relying on `max-age`, so freshness does not
 * depend on when the cache evicts.
 */
const FRESH_UNTIL_HEADER = "x-canopy-fresh-until";

/**
 * Builds the production reader.
 *
 * @param config.serviceUrl univocity base URL (`UNIVOCITY_SERVICE_URL`).
 * @param config.token optional bearer for univocity; `/authority` does not
 *   require one today.
 * @param config.anchoredCacheSeconds how long an anchored answer that is not
 *   yet final is cached (`UNIVOCITY_AUTHORITY_CACHE_SECONDS`).
 * @param config.cache Cache API cache; defaults to `caches.default`.
 * @param config.now clock in unix ms; defaults to `Date.now`.
 */
export function createUnivocityLogAuthorityReader(config: {
  serviceUrl: string;
  token?: string;
  anchoredCacheSeconds: number;
  cache?: Cache;
  now?: () => number;
}): LogAuthorityReader {
  const base = config.serviceUrl.trim().replace(/\/+$/, "");
  const token = config.token?.trim();
  const now = config.now ?? Date.now;

  return {
    async read(logId: Uint8Array): Promise<LogAuthority> {
      const url = `${base}/api/logs/${bytesToUuid(logId)}/authority`;
      const cache = config.cache ?? caches.default;

      const cached = await cache.match(url);
      if (cached) {
        const freshUntil = Number(cached.headers.get(FRESH_UNTIL_HEADER));
        if (!freshUntil || now() < freshUntil) {
          return classify(decodeFields(await cached.arrayBuffer()));
        }
      }

      let res: Response;
      try {
        res = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/cbor",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
      } catch (e) {
        return {
          kind: "unavailable",
          detail: `univocity authority unreachable: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      if (res.status === 404) return { kind: "unclaimed" };
      if (!res.ok) {
        return {
          kind: "unavailable",
          detail: `univocity authority returned ${res.status}`,
        };
      }

      const body = await res.arrayBuffer();
      let authority: LogAuthority;
      try {
        authority = classify(decodeFields(body));
      } catch (e) {
        return {
          kind: "unavailable",
          detail: `univocity authority answer is malformed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      const ttl = cacheSeconds(authority, config.anchoredCacheSeconds);
      if (ttl !== null) {
        const headers: Record<string, string> = {
          "content-type": "application/cbor",
          "cache-control": `public, max-age=${ttl}`,
        };
        if (ttl !== FINAL_CACHE_SECONDS) {
          headers[FRESH_UNTIL_HEADER] = String(now() + ttl * 1000);
        }
        await cache.put(url, new Response(body, { status: 200, headers }));
      }
      return authority;
    },
  };
}

/** Seconds to cache an answer for, or null when it must not be cached. */
function cacheSeconds(
  authority: LogAuthority,
  anchoredCacheSeconds: number,
): number | null {
  if (authority.kind === "conflicted") return FINAL_CACHE_SECONDS;
  if (authority.kind !== "anchored") return null;
  if (authority.final) return FINAL_CACHE_SECONDS;
  return anchoredCacheSeconds > 0 ? anchoredCacheSeconds : null;
}

/** Decodes univocity's CBOR answer into a field record. */
function decodeFields(body: ArrayBuffer): Record<string, unknown> {
  const decoded = decodeCborDeterministic(new Uint8Array(body));
  if (decoded instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of decoded.entries()) out[String(k)] = v;
    return out;
  }
  if (typeof decoded === "object" && decoded !== null) {
    return decoded as Record<string, unknown>;
  }
  throw new Error("authority answer must be a CBOR map");
}

/**
 * Reduces univocity's answer to a {@link LogAuthority}. Usable authority is
 * `anchored` with no `blockedBy` (univocity `Authority.usable`). A final
 * answer with `blockedBy` names a conflicted ancestor, which no wait resolves,
 * so it is conflicted here too.
 */
function classify(f: Record<string, unknown>): LogAuthority {
  const state = typeof f.state === "string" ? f.state : "";
  if (!state) throw new Error("authority answer has no state");
  const blockedBy = f.blockedBy instanceof Uint8Array ? f.blockedBy : undefined;
  const final = f.final === true;

  if (state === AUTHORITY_STATE_CONFLICTED || (final && blockedBy)) {
    return blockedBy
      ? { kind: "conflicted", blockedBy }
      : { kind: "conflicted" };
  }
  if (state === AUTHORITY_STATE_ANCHORED && !blockedBy) {
    const alg = toInt(f.alg);
    const key = f.key instanceof Uint8Array ? f.key : undefined;
    if (alg === null || !key) throw new Error("anchored answer has no key");
    const chainId =
      typeof f.chainId === "string" && /^\d+$/.test(f.chainId)
        ? f.chainId
        : undefined;
    return {
      kind: "anchored",
      final,
      alg,
      key,
      ...(chainId ? { chainId } : {}),
    };
  }
  const expiresAt = toInt(f.expiresAt);
  return {
    kind: "pending",
    state,
    ...(blockedBy ? { blockedBy } : {}),
    ...(expiresAt !== null ? { expiresAt } : {}),
  };
}

function toInt(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "bigint") {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}
