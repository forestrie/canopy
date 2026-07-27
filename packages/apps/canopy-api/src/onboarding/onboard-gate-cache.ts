import { onboardGateCacheR2Key } from "./onboard-gate-cache-key.js";

export interface OnboardGateCacheEnv {
  R2_GRANTS: R2Bucket;
  ONBOARD_GATE_CACHE_TTL_SEC?: string;
}

function defaultGateCacheTtlSec(env: OnboardGateCacheEnv): number {
  const raw = env.ONBOARD_GATE_CACHE_TTL_SEC?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 300;
}

/** Cached positive gate result: the chain-declared bootstrap identity. */
export interface GateCacheEntry {
  alg: number;
  key: Uint8Array;
}

function keyToB64(key: Uint8Array): string {
  let s = "";
  for (const b of key) s += String.fromCharCode(b);
  return btoa(s);
}

function keyFromB64(b64: string): Uint8Array | null {
  try {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Read the cached positive gate result. Returns the cached bootstrap identity
 * or null on miss/expiry. Legacy entries (a bare epoch integer, pre slice 06)
 * carry no identity and read as a miss — the next probe rewrites them.
 */
export async function readPositiveGateCache(
  env: OnboardGateCacheEnv,
  chainId: string,
  univocityAddr: string,
): Promise<GateCacheEntry | null> {
  const got = await env.R2_GRANTS.get(
    onboardGateCacheR2Key(chainId, univocityAddr),
  );
  if (!got) return null;
  let parsed: { expiresAt?: number; alg?: number; keyB64?: string };
  try {
    parsed = JSON.parse(await got.text()) as typeof parsed;
  } catch {
    return null;
  }
  if (
    typeof parsed.expiresAt !== "number" ||
    parsed.expiresAt <= Math.floor(Date.now() / 1000) ||
    typeof parsed.alg !== "number" ||
    typeof parsed.keyB64 !== "string"
  ) {
    return null;
  }
  const key = keyFromB64(parsed.keyB64);
  if (!key) return null;
  return { alg: parsed.alg, key };
}

export async function writePositiveGateCache(
  env: OnboardGateCacheEnv,
  chainId: string,
  univocityAddr: string,
  entry: GateCacheEntry,
): Promise<void> {
  const ttl = defaultGateCacheTtlSec(env);
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  await env.R2_GRANTS.put(
    onboardGateCacheR2Key(chainId, univocityAddr),
    JSON.stringify({ expiresAt, alg: entry.alg, keyB64: keyToB64(entry.key) }),
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { expiresAt: String(expiresAt) },
    },
  );
}
