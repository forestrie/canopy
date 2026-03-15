/**
 * Grant-signing delegation endpoints (Plan 0004 subplan 04).
 * POST /api/delegate/bootstrap and POST /api/delegate/parent.
 * Caller sends digest (payload_hash); delegation-signer signs with the
 * appropriate KMS key (bootstrap/root or parent auth log) and returns signature.
 */

import { ClientErrors, ServerErrors } from "./http/problem-details";
import { KmsError, kmsAsymmetricSignSha256 } from "./kms/client";
import {
  signDigestSha256 as testKeySignDigest,
  signDigestSha256Es256 as testKeySignDigestEs256,
} from "./kms/test-key-signer";
import type { KmsKeyVersionRef } from "./kms/client";
import { kmsDerSignatureToCoseRaw } from "./cose/sign1";
/**
 * Subset of Env used by grant-delegate handlers (avoids circular import).
 */
export interface DelegateGrantEnv {
  FOREST_PROJECT_ID: string;
  GCP_LOCATION: string;
  KMS_KEY_RING: string;
  KMS_KEY_SECP256K1: string;
  KMS_KEY_SECP256R1: string;
  KMS_KEY_VERSION: string;
  DELEGATION_SIGNER_UNIVOCITY_URL?: string;
  DELEGATION_SIGNER_ROOT_LOG_ID?: string;
  DELEGATION_SIGNER_PARENT_KEYS_JSON?: string;
  DELEGATION_SIGNER_USE_TEST_KEY?: string;
  DELEGATION_SIGNER_TEST_KEY_PRIVATE_HEX?: string;
}

export type BootstrapAlg = "ES256" | "KS256";

function useTestKey(env: DelegateGrantEnv): boolean {
  const v = env.DELEGATION_SIGNER_USE_TEST_KEY?.trim().toLowerCase();
  return v === "1" || v === "true";
}

const JSON_MIME = "application/json";

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  return token.length ? token : null;
}

function hexToBytes(hex: string): Uint8Array {
  const s = hex.replace(/^0x/i, "").trim();
  if (s.length !== 64 || !/^[0-9a-fA-F]+$/.test(s)) {
    throw new Error("payload_hash must be 64 hex chars (32 bytes)");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function jsonResponse(obj: object, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": JSON_MIME,
      "cache-control": "no-store",
    },
  });
}

function mapKmsError(err: unknown): Response {
  const status = err instanceof KmsError ? err.status : 500;
  const detail = err instanceof KmsError ? err.responseText : undefined;
  if (status === 401) return ClientErrors.unauthorized("KMS rejected token");
  if (status === 403) return ClientErrors.forbidden("KMS denied access");
  return ServerErrors.badGateway(detail ?? `KMS error (${status})`);
}

function bootstrapKeyRef(env: DelegateGrantEnv, alg: BootstrapAlg): KmsKeyVersionRef {
  const cryptoKey = alg === "KS256" ? env.KMS_KEY_SECP256K1 : env.KMS_KEY_SECP256R1;
  return {
    projectId: env.FOREST_PROJECT_ID,
    location: env.GCP_LOCATION,
    keyRing: env.KMS_KEY_RING,
    cryptoKey,
    cryptoKeyVersion: env.KMS_KEY_VERSION,
  };
}

function parseBootstrapAlg(raw: string | undefined): BootstrapAlg {
  const s = raw?.trim().toUpperCase();
  if (s === "KS256") return "KS256";
  return "ES256"; // default
}

function normalizeLogIdHex(s: string): string {
  const t = s.replace(/^0x/i, "").trim().toLowerCase();
  if (t.length !== 64 || !/^[0-9a-f]+$/.test(t)) return "";
  return t;
}

type ParentKeyRef = { cryptoKey: string; cryptoKeyVersion: string };

function parseParentKeysJson(
  raw: string | undefined,
): Map<string, ParentKeyRef> {
  const m = new Map<string, ParentKeyRef>();
  if (!raw?.trim()) return m;
  try {
    const o = JSON.parse(raw) as Record<
      string,
      { cryptoKey?: string; cryptoKeyVersion?: string }
    >;
    for (const [k, v] of Object.entries(o)) {
      const normalized = normalizeLogIdHex(k);
      if (normalized && v?.cryptoKey && v?.cryptoKeyVersion) {
        m.set(normalized, {
          cryptoKey: v.cryptoKey,
          cryptoKeyVersion: v.cryptoKeyVersion,
        });
      }
    }
  } catch {
    // ignore invalid JSON
  }
  return m;
}

async function resolveRootLogId(env: DelegateGrantEnv): Promise<string | null> {
  const fromEnv = env.DELEGATION_SIGNER_ROOT_LOG_ID?.trim();
  if (fromEnv) return fromEnv;
  const base = env.DELEGATION_SIGNER_UNIVOCITY_URL?.trim().replace(/\/$/, "");
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/root`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { exists?: boolean; rootLogId?: string };
    if (data.exists && data.rootLogId) return data.rootLogId;
  } catch {
    // ignore
  }
  return null;
}

/** Resolve parent_log_id to KMS key ref. Returns null if not found. */
async function resolveParentKeyRef(
  env: DelegateGrantEnv,
  parentLogIdHex: string,
): Promise<KmsKeyVersionRef | null> {
  const normalized = normalizeLogIdHex(parentLogIdHex);
  if (!normalized) return null;

  const rootLogId = await resolveRootLogId(env);
  if (rootLogId) {
    const normalizedRoot = normalizeLogIdHex(rootLogId);
    if (normalizedRoot && normalizedRoot === normalized) {
      return bootstrapKeyRef(env);
    }
  }

  const parentKeys = parseParentKeysJson(
    env.DELEGATION_SIGNER_PARENT_KEYS_JSON,
  );
  const ref = parentKeys.get(normalized);
  if (ref) {
    return {
      projectId: env.FOREST_PROJECT_ID,
      location: env.GCP_LOCATION,
      keyRing: env.KMS_KEY_RING,
      cryptoKey: ref.cryptoKey,
      cryptoKeyVersion: ref.cryptoKeyVersion,
    };
  }
  return null;
}

async function signDigestWithKey(
  token: string,
  ref: KmsKeyVersionRef,
  digestSha256: Uint8Array,
): Promise<string> {
  const signatureDer = await kmsAsymmetricSignSha256(token, ref, digestSha256);
  const signatureRaw = kmsDerSignatureToCoseRaw(signatureDer);
  return bytesToHex(signatureRaw);
}

/**
 * POST /api/delegate/bootstrap
 * Body: JSON { payload_hash?: string, cose_tbs_hash?: string, alg?: "ES256"|"KS256" }.
 * - payload_hash / cose_tbs_hash: 64 hex chars (either, not both). Default alg is ES256.
 * Returns: JSON { signature: string } (hex, raw r||s).
 */
export async function handleDelegateBootstrap(
  request: Request,
  env: DelegateGrantEnv,
): Promise<Response> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    return ClientErrors.unauthorized(
      "Missing or invalid Authorization header",
      {
        "WWW-Authenticate": "Bearer",
      },
    );
  }

  if (
    request.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/json") !== true
  ) {
    return ClientErrors.unsupportedMediaType("Use application/json");
  }

  let body: { payload_hash?: string; cose_tbs_hash?: string; alg?: string };
  try {
    body = (await request.json()) as {
      payload_hash?: string;
      cose_tbs_hash?: string;
      alg?: string;
    };
  } catch {
    return ClientErrors.badRequest("Invalid JSON body");
  }

  const alg = parseBootstrapAlg(body.alg);

  const payloadHash = body.payload_hash?.trim();
  const coseTbsHash = body.cose_tbs_hash?.trim();
  if (coseTbsHash) {
    if (payloadHash) {
      return ClientErrors.badRequest(
        "Send either payload_hash or cose_tbs_hash, not both",
      );
    }
  } else if (!payloadHash) {
    return ClientErrors.badRequest(
      "payload_hash or cose_tbs_hash is required (64 hex chars)",
    );
  }

  const hashHex = coseTbsHash ?? payloadHash;
  let digest: Uint8Array;
  try {
    digest = hexToBytes(hashHex!);
  } catch (e) {
    return ClientErrors.badRequest(
      e instanceof Error ? e.message : "invalid hash (64 hex chars)",
    );
  }

  if (useTestKey(env)) {
    try {
      const raw =
        alg === "KS256"
          ? testKeySignDigest(
              digest,
              env.DELEGATION_SIGNER_TEST_KEY_PRIVATE_HEX?.trim() || undefined,
            )
          : testKeySignDigestEs256(digest);
      return jsonResponse({ signature: bytesToHex(raw) });
    } catch (e) {
      return ServerErrors.internal(
        e instanceof Error ? e.message : "Test key sign failed",
      );
    }
  }

  const ref = bootstrapKeyRef(env, alg);
  try {
    const signature = await signDigestWithKey(token, ref, digest);
    return jsonResponse({ signature });
  } catch (e) {
    return mapKmsError(e);
  }
}

/**
 * POST /api/delegate/parent
 * Body: JSON { parent_log_id: string, payload_hash: string }.
 * parent_log_id: 0x-prefixed 32-byte hex of the parent auth log.
 * Returns: JSON { signature: string } (hex, raw r||s).
 */
export async function handleDelegateParent(
  request: Request,
  env: DelegateGrantEnv,
): Promise<Response> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    return ClientErrors.unauthorized(
      "Missing or invalid Authorization header",
      {
        "WWW-Authenticate": "Bearer",
      },
    );
  }

  if (
    request.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/json") !== true
  ) {
    return ClientErrors.unsupportedMediaType("Use application/json");
  }

  let body: { parent_log_id?: string; payload_hash?: string };
  try {
    body = (await request.json()) as {
      parent_log_id?: string;
      payload_hash?: string;
    };
  } catch {
    return ClientErrors.badRequest("Invalid JSON body");
  }

  const parentLogId = body.parent_log_id?.trim();
  if (!parentLogId) {
    return ClientErrors.badRequest(
      "parent_log_id is required (0x-prefixed 32-byte hex)",
    );
  }

  const payloadHash = body.payload_hash?.trim();
  if (!payloadHash) {
    return ClientErrors.badRequest("payload_hash is required (64 hex chars)");
  }

  let digest: Uint8Array;
  try {
    digest = hexToBytes(payloadHash);
  } catch (e) {
    return ClientErrors.badRequest(
      e instanceof Error ? e.message : "invalid payload_hash",
    );
  }

  const ref = await resolveParentKeyRef(env, parentLogId);
  if (!ref) {
    return ClientErrors.notFound(
      "No key configured for this parent_log_id (not root and not in PARENT_KEYS)",
    );
  }

  try {
    const signature = await signDigestWithKey(token, ref, digest);
    return jsonResponse({ signature });
  } catch (e) {
    return mapKmsError(e);
  }
}
