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

export async function readPositiveGateCache(
  env: OnboardGateCacheEnv,
  chainId: string,
  univocityAddr: string,
): Promise<boolean> {
  const got = await env.R2_GRANTS.get(
    onboardGateCacheR2Key(chainId, univocityAddr),
  );
  if (!got) return false;
  const expiresAt = Number.parseInt(
    new TextDecoder().decode(new Uint8Array(await got.arrayBuffer())),
    10,
  );
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt > Math.floor(Date.now() / 1000);
}

export async function writePositiveGateCache(
  env: OnboardGateCacheEnv,
  chainId: string,
  univocityAddr: string,
): Promise<void> {
  const ttl = defaultGateCacheTtlSec(env);
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  await env.R2_GRANTS.put(
    onboardGateCacheR2Key(chainId, univocityAddr),
    String(expiresAt),
    {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: { expiresAt: String(expiresAt) },
    },
  );
}
