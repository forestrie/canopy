import { canonicalizeCbor } from "./cbor/canonical";
import { parseCborBody } from "./cbor/codec";
import { ClientErrors, ServerErrors, cborResponse } from "./http/problem-details";
import { KmsError, kmsAsymmetricSignSha256, kmsGetPublicKeyDer } from "./kms/client";
import {
  assembleCoseSign1,
  buildDelegationToBeSigned,
  kmsDerSignatureToCoseRaw,
  type DelegatedCoseKey,
  type DelegationCurve,
} from "./cose/sign1";
import { deriveKidFromPublicKeyDer } from "./cose/kid";

export interface Env {
  FOREST_PROJECT_ID: string;
  GCP_LOCATION: string;
  KMS_KEY_RING: string;
  KMS_KEY_SECP256K1: string;
  KMS_KEY_SECP256R1: string;
  KMS_KEY_VERSION: string;
  MASSIF_HEIGHT: number;
  NODE_ENV: string;
  /**
   * Optional override: 16-byte kid for the secp256k1 root key, base64 encoded.
   */
  KMS_KID_SECP256K1_B64?: string;
  /**
   * Optional override: 16-byte kid for the secp256r1 root key, base64 encoded.
   */
  KMS_KID_SECP256R1_B64?: string;
}

type LogSpecificDelegationRequest = {
  log_id: string;
  mmr_start: number | bigint;
  mmr_end: number | bigint;
  delegated_pubkey: unknown;
  constraints?: unknown;
  issued_at?: number | bigint;
  expires_at?: number | bigint;
  log_id_prefix?: never;
};

type PrefixScopedDelegationRequest = {
  log_id?: never;
  mmr_start?: never;
  mmr_end?: never;
  delegated_pubkey: unknown;
  constraints?: unknown;
  issued_at?: number | bigint;
  expires_at?: number | bigint;
  /**
   * Optional log shard constraint:
   * - undefined/empty: no constraint
   * - hex prefix (1..32 chars), optionally with 0x prefix
   */
  log_id_prefix?: string;
};

type DelegationRequest = LogSpecificDelegationRequest | PrefixScopedDelegationRequest;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as any).constructor === Object
  );
}

function constraintsHasKey(constraints: unknown, key: string): boolean {
  if (constraints instanceof Map) return constraints.has(key);
  if (isPlainObject(constraints)) {
    return Object.prototype.hasOwnProperty.call(constraints, key);
  }
  return false;
}

/**
 * Normalize an optional log_id_prefix.
 *
 * - undefined/null/empty string => undefined (no constraint)
 * - accepts optional 0x prefix
 * - 1..32 hex chars
 */
function normalizeLogIdPrefix(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new Error("log_id_prefix must be a string");
  }

  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const without0x =
    trimmed.toLowerCase().startsWith("0x") ? trimmed.slice(2) : trimmed;

  if (!without0x) return undefined;
  if (without0x.length > 32) {
    throw new Error("log_id_prefix must be <= 32 hex chars");
  }
  if (!/^[0-9a-fA-F]+$/.test(without0x)) {
    throw new Error("log_id_prefix must be hex");
  }

  return without0x.toLowerCase();
}

function addLogIdPrefixToConstraints(
  constraintsInput: unknown,
  prefix: string | undefined,
): unknown {
  if (constraintsHasKey(constraintsInput, "log_id_prefix")) {
    throw new Error("log_id_prefix must be top-level, not inside constraints");
  }

  if (!prefix) {
    return constraintsInput ?? new Map();
  }

  if (constraintsInput === undefined || constraintsInput === null) {
    return new Map<string, unknown>([["log_id_prefix", prefix]]);
  }
  if (constraintsInput instanceof Map) {
    const out = new Map<string, unknown>();
    for (const [k, v] of constraintsInput.entries()) {
      if (typeof k !== "string") {
        throw new Error("constraints map keys must be text strings");
      }
      out.set(k, v);
    }
    out.set("log_id_prefix", prefix);
    return out;
  }
  if (isPlainObject(constraintsInput)) {
    return { ...constraintsInput, log_id_prefix: prefix };
  }

  throw new Error("constraints must be a map");
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  return token.length ? token : null;
}

function toUint64BigInt(value: unknown, name: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${name} must be unsigned`);
    if (value > 0xffff_ffff_ffff_ffffn) {
      throw new Error(`${name} must fit in uint64`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`${name} must be an integer`);
    }
    if (value < 0) throw new Error(`${name} must be unsigned`);
    if (value > Number.MAX_SAFE_INTEGER) {
      // Avoid silently losing precision.
      throw new Error(`${name} exceeds JS safe integer range; use CBOR bigint`);
    }
    return BigInt(value);
  }
  throw new Error(`${name} must be a uint`);
}

function parseDelegatedCoseKey(value: unknown): DelegatedCoseKey {
  // Expect a CBOR map (decoded as Map or object) with integer keys.
  const get = (k: number): unknown => {
    if (value instanceof Map) return value.get(k);
    if (typeof value === "object" && value !== null) return (value as any)[String(k)];
    return undefined;
  };

  const kty = get(1);
  const crv = get(-1);
  const x = get(-2);
  const y = get(-3);

  if (kty !== 2) throw new Error("delegated_pubkey.kty must be EC2 (2)");
  if (crv !== 8 && crv !== 1) {
    throw new Error("delegated_pubkey.crv must be secp256k1 (8) or P-256 (1)");
  }
  if (!(x instanceof Uint8Array) || x.length !== 32) {
    throw new Error("delegated_pubkey.x must be 32-byte bstr");
  }
  if (!(y instanceof Uint8Array) || y.length !== 32) {
    throw new Error("delegated_pubkey.y must be 32-byte bstr");
  }

  return {
    kty: 2,
    crv,
    x,
    y,
  };
}

function curveFromDelegatedKey(key: DelegatedCoseKey): DelegationCurve {
  return key.crv === 8 ? "secp256k1" : "secp256r1";
}

async function getKidForCurve(
  accessToken: string,
  env: Env,
  curve: DelegationCurve,
): Promise<Uint8Array> {
  const override =
    curve === "secp256k1" ? env.KMS_KID_SECP256K1_B64 : env.KMS_KID_SECP256R1_B64;
  if (override) {
    const kid = base64ToBytes(override);
    if (kid.length !== 16) {
      throw new Error(`${curve} kid override must be 16 bytes`);
    }
    return kid;
  }

  const cryptoKey = curve === "secp256k1" ? env.KMS_KEY_SECP256K1 : env.KMS_KEY_SECP256R1;
  const der = await kmsGetPublicKeyDer(accessToken, {
    projectId: env.FOREST_PROJECT_ID,
    location: env.GCP_LOCATION,
    keyRing: env.KMS_KEY_RING,
    cryptoKey,
    cryptoKeyVersion: env.KMS_KEY_VERSION,
  });
  return deriveKidFromPublicKeyDer(der);
}

function policyMaxWidth(massifHeight: number): bigint {
  if (!Number.isFinite(massifHeight) || !Number.isInteger(massifHeight) || massifHeight <= 0) {
    throw new Error("MASSIF_HEIGHT must be a positive integer");
  }
  return (1n << BigInt(massifHeight)) - 1n;
}

function mapKmsError(err: unknown): Response {
  const status = err instanceof KmsError ? err.status : 500;
  const detail = err instanceof KmsError ? err.responseText : undefined;

  if (status === 401) return ClientErrors.unauthorized("KMS rejected token");
  if (status === 403) return ClientErrors.forbidden("KMS denied access");
  return ServerErrors.badGateway(detail ?? `KMS error (${status})`);
}

async function handleDelegation(request: Request, env: Env): Promise<Response> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    return ClientErrors.unauthorized("Missing or invalid Authorization header", {
      "WWW-Authenticate": "Bearer",
    });
  }

  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("application/cbor")) {
    return ClientErrors.unsupportedMediaType("Use application/cbor");
  }

  let body: DelegationRequest;
  try {
    body = await parseCborBody<DelegationRequest>(request);
  } catch (e) {
    return ClientErrors.badRequest(
      `Failed to parse CBOR body: ${e instanceof Error ? e.message : "unknown error"}`,
    );
  }

  const raw = body as any;
  const hasLogId = raw.log_id !== undefined;
  const hasMmrStart = raw.mmr_start !== undefined;
  const hasMmrEnd = raw.mmr_end !== undefined;
  const hasLogIdPrefix = raw.log_id_prefix !== undefined;

  if (raw.delegated_pubkey === undefined) {
    return ClientErrors.badRequest("delegated_pubkey is required");
  }

  // Shared fields
  let issuedAt: bigint | undefined;
  let expiresAt: bigint | undefined;

  try {
    if (raw.issued_at !== undefined) {
      issuedAt = toUint64BigInt(raw.issued_at, "issued_at");
    }
    if (raw.expires_at !== undefined) {
      expiresAt = toUint64BigInt(raw.expires_at, "expires_at");
    }
  } catch (e) {
    return ClientErrors.badRequest(
      e instanceof Error ? e.message : "invalid time field",
    );
  }

  // Two request shapes:
  // 1) log-scoped: log_id + mmr_start + mmr_end
  // 2) prefix/no-log: optional log_id_prefix, no log_id/mmr_start/mmr_end
  let logId: string | undefined;
  let mmrStart: bigint | undefined;
  let mmrEnd: bigint | undefined;
  let logIdPrefix: string | undefined;

  if (hasLogId) {
    if (hasLogIdPrefix) {
      return ClientErrors.badRequest(
        "log_id_prefix is not allowed when log_id is provided",
      );
    }
    if (!isNonEmptyString(raw.log_id)) {
      return ClientErrors.badRequest("log_id is required");
    }
    logId = raw.log_id;

    if (!hasMmrStart || !hasMmrEnd) {
      return ClientErrors.badRequest(
        "mmr_start and mmr_end are required for log-scoped delegations",
      );
    }
    try {
      mmrStart = toUint64BigInt(raw.mmr_start, "mmr_start");
      mmrEnd = toUint64BigInt(raw.mmr_end, "mmr_end");
    } catch (e) {
      return ClientErrors.badRequest(
        e instanceof Error ? e.message : "invalid mmr field",
      );
    }
    if (mmrEnd < mmrStart) {
      return ClientErrors.badRequest("mmr_end must be >= mmr_start");
    }

    // Enforce basic policy *before* invoking KMS.
    const width = mmrEnd - mmrStart + 1n;
    const maxWidth = policyMaxWidth(env.MASSIF_HEIGHT);
    if (width > maxWidth) {
      return ClientErrors.forbidden(
        `MMR range width ${width.toString()} exceeds one massif (${maxWidth.toString()})`,
      );
    }
  } else {
    // prefix/no-log request
    if (hasMmrStart || hasMmrEnd) {
      return ClientErrors.badRequest("mmr_start/mmr_end require log_id");
    }
    try {
      logIdPrefix = normalizeLogIdPrefix(raw.log_id_prefix);
    } catch (e) {
      return ClientErrors.badRequest(
        e instanceof Error ? e.message : "invalid log_id_prefix",
      );
    }
  }

  let delegatedKey: DelegatedCoseKey;
  try {
    delegatedKey = parseDelegatedCoseKey(raw.delegated_pubkey);
  } catch (e) {
    return ClientErrors.badRequest(
      e instanceof Error ? e.message : "invalid delegated_pubkey",
    );
  }

  const curve = curveFromDelegatedKey(delegatedKey);

  // Canonicalize constraints map to satisfy deterministic CBOR requirements.
  // For prefix/no-log requests we inject the normalized log_id_prefix into the signed constraints.
  let constraints: unknown;
  try {
    const constraintsInput = raw.constraints;
    const merged =
      logId === undefined
        ? addLogIdPrefixToConstraints(constraintsInput, logIdPrefix)
        : constraintsInput ?? new Map();

    // Enforce a single source of truth:
    // - For log-scoped requests, log_id_prefix is not allowed at all.
    // - For prefix/no-log requests, addLogIdPrefixToConstraints already enforces that
    //   the caller doesn't smuggle log_id_prefix via constraints.
    if (logId !== undefined && constraintsHasKey(merged, "log_id_prefix")) {
      throw new Error("log_id_prefix is only valid for prefix/no-log delegations");
    }

    constraints = canonicalizeCbor(merged);
  } catch (e) {
    return ClientErrors.badRequest(
      e instanceof Error ? e.message : "invalid constraints",
    );
  }

  const delegationId = new Uint8Array(16);
  crypto.getRandomValues(delegationId);

  let kid: Uint8Array;
  try {
    kid = await getKidForCurve(token, env, curve);
  } catch (e) {
    return ServerErrors.internal(e instanceof Error ? e.message : "failed to derive kid");
  }

  const tbs = await buildDelegationToBeSigned(curve, kid, {
    logId,
    mmrStart,
    mmrEnd,
    delegatedKey,
    constraints,
    delegationId,
    issuedAt,
    expiresAt,
  });

  const cryptoKey = curve === "secp256k1" ? env.KMS_KEY_SECP256K1 : env.KMS_KEY_SECP256R1;

  let signatureDer: Uint8Array;
  try {
    signatureDer = await kmsAsymmetricSignSha256(token, {
      projectId: env.FOREST_PROJECT_ID,
      location: env.GCP_LOCATION,
      keyRing: env.KMS_KEY_RING,
      cryptoKey,
      cryptoKeyVersion: env.KMS_KEY_VERSION,
    }, tbs.digestSha256);
  } catch (e) {
    return mapKmsError(e);
  }

  let signatureRaw: Uint8Array;
  try {
    signatureRaw = kmsDerSignatureToCoseRaw(signatureDer);
  } catch (e) {
    return ServerErrors.internal(
      e instanceof Error ? `signature conversion failed: ${e.message}` : "signature conversion failed",
    );
  }

  const cose = assembleCoseSign1(tbs.protectedBytes, tbs.payloadBytes, signatureRaw);
  return new Response(cose as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": 'application/cose; cose-type="cose-sign1"',
      "cache-control": "no-store",
      "content-length": String(cose.byteLength),
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return cborResponse(
        {
          status: "healthy",
          forestProjectId: env.FOREST_PROJECT_ID,
          env: env.NODE_ENV,
        },
        200,
      );
    }

    if (url.pathname === "/api/delegations") {
      if (request.method !== "POST") {
        return ClientErrors.methodNotAllowed(
          `Use POST for ${url.pathname}`,
        );
      }
      return handleDelegation(request, env);
    }

    return ClientErrors.notFound(`The requested resource ${url.pathname} was not found`);
  },
};


