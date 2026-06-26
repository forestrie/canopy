import type {
  OnboardTokenChainBinding,
  OnboardTokenRecord,
} from "./onboard-token-record.js";
import { hashOnboardToken, onboardTokenR2Key } from "./onboard-token-hash.js";

export interface OnboardTokenStoreEnv {
  R2_GRANTS: R2Bucket;
}

function encodeRecord(record: OnboardTokenRecord): string {
  return JSON.stringify(record);
}

function decodeRecord(bytes: Uint8Array): OnboardTokenRecord | null {
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(bytes),
    ) as OnboardTokenRecord;
    if (
      typeof parsed.hash !== "string" ||
      typeof parsed.createdAt !== "number" ||
      (parsed.status !== "active" && parsed.status !== "revoked")
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function generateTokenValue(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface MintOnboardTokenOptions {
  label?: string;
  expiry?: number;
  requestId?: string;
  chainBinding?: OnboardTokenChainBinding;
}

export interface MintOnboardTokenResult {
  token: string;
  record: OnboardTokenRecord;
}

export async function mintOnboardToken(
  env: OnboardTokenStoreEnv,
  options: MintOnboardTokenOptions = {},
): Promise<MintOnboardTokenResult> {
  const token = generateTokenValue();
  const hash = await hashOnboardToken(token);
  const record: OnboardTokenRecord = {
    hash,
    label: options.label,
    createdAt: Math.floor(Date.now() / 1000),
    expiry: options.expiry,
    status: "active",
    requestId: options.requestId,
    chainBinding: options.chainBinding,
  };
  await env.R2_GRANTS.put(onboardTokenR2Key(hash), encodeRecord(record), {
    httpMetadata: { contentType: "application/json" },
  });
  return { token, record };
}

export async function listOnboardTokens(
  env: OnboardTokenStoreEnv,
): Promise<OnboardTokenRecord[]> {
  const listed = await env.R2_GRANTS.list({
    prefix: "payments/onboard-tokens/",
  });
  const out: OnboardTokenRecord[] = [];
  for (const obj of listed.objects) {
    const got = await env.R2_GRANTS.get(obj.key);
    if (!got) continue;
    const record = decodeRecord(new Uint8Array(await got.arrayBuffer()));
    if (record) out.push(record);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export async function readOnboardTokenRecord(
  env: OnboardTokenStoreEnv,
  hash: string,
): Promise<OnboardTokenRecord | null> {
  const got = await env.R2_GRANTS.get(onboardTokenR2Key(hash));
  if (!got) return null;
  return decodeRecord(new Uint8Array(await got.arrayBuffer()));
}

export async function revokeOnboardToken(
  env: OnboardTokenStoreEnv,
  hash: string,
): Promise<OnboardTokenRecord | null> {
  const existing = await readOnboardTokenRecord(env, hash);
  if (!existing) return null;
  const updated: OnboardTokenRecord = { ...existing, status: "revoked" };
  await env.R2_GRANTS.put(onboardTokenR2Key(hash), encodeRecord(updated), {
    httpMetadata: { contentType: "application/json" },
  });
  return updated;
}

export async function isOnboardTokenActive(
  env: OnboardTokenStoreEnv,
  presentedToken: string,
): Promise<{ active: true; hash: string } | { active: false }> {
  const trimmed = presentedToken.trim();
  if (!trimmed) return { active: false };
  const hash = await hashOnboardToken(trimmed);
  const record = await readOnboardTokenRecord(env, hash);
  if (!record || record.status !== "active") return { active: false };
  if (record.expiry != null && record.expiry <= Math.floor(Date.now() / 1000)) {
    return { active: false };
  }
  return { active: true, hash };
}

export async function readOnboardTokenByHash(
  env: OnboardTokenStoreEnv,
  hash: string,
): Promise<OnboardTokenRecord | null> {
  return readOnboardTokenRecord(env, hash);
}

export async function markOnboardTokenConsumed(
  env: OnboardTokenStoreEnv,
  hash: string,
  forestR: string,
): Promise<OnboardTokenRecord | null> {
  const existing = await readOnboardTokenRecord(env, hash);
  if (!existing) return null;
  if (existing.consumedForestR) return existing;
  const updated: OnboardTokenRecord = { ...existing, consumedForestR: forestR };
  await env.R2_GRANTS.put(onboardTokenR2Key(hash), encodeRecord(updated), {
    httpMetadata: { contentType: "application/json" },
  });
  return updated;
}
