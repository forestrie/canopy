/**
 * Subplan 08 / Plan 0010 / Plan 0014: Bootstrap grant mint (no server-side storage).
 * POST /api/grants/bootstrap — build grant, sign via Custodian (RFC 8152 COSE Sign1),
 * return transparent statement in response body (201, base64).
 *
 * Plan 0011 §0: grantData must equal the bootstrap public key (64 bytes for ES256).
 */

import type { Grant } from "../grant/grant.js";
import { encodeGrantPayload } from "../grant/codec.js";
import {
  CUSTODIAN_BOOTSTRAP_KEY_ID,
  fetchCustodianPublicKey,
  mergeGrantHeadersIntoCustodianSign1,
  postCustodianSignGrantPayload,
  publicKeyPemToUncompressed65,
} from "./custodian-grant.js";
import { ClientErrors, ServerErrors } from "./problem-details.js";

const WIRE_LOG_ID_BYTES = 32;

/** 64 hex chars → 32 bytes. */
function hexToBytes32(hex: string): Uint8Array {
  const s = hex.replace(/^0x/i, "").trim().toLowerCase();
  if (s.length !== 64 || !/^[0-9a-f]+$/.test(s)) {
    throw new Error("rootLogId must be 64 hex chars (32 bytes)");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Parse logId string to 32-byte wire format. Accepts:
 * - 64 hex chars (32 bytes)
 * - UUID (with or without dashes, 32 hex = 16 bytes), left-padded to 32
 */
function logIdToWireBytes(logId: string): Uint8Array {
  const s = logId.replace(/-/g, "").trim().toLowerCase();
  if (s.length === 64 && /^[0-9a-f]+$/.test(s)) {
    return hexToBytes32(s);
  }
  if (s.length === 32 && /^[0-9a-f]+$/.test(s)) {
    const uuidBytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      uuidBytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    }
    const out = new Uint8Array(WIRE_LOG_ID_BYTES);
    out.set(uuidBytes, WIRE_LOG_ID_BYTES - 16);
    return out;
  }
  throw new Error("rootLogId must be 64 hex chars or a UUID (32 hex)");
}

export interface BootstrapMintEnv {
  /** Default when request body does not include rootLogId. */
  rootLogId?: string;
  custodianUrl: string;
  custodianBootstrapAppToken: string;
  /** Alg for bootstrap signing; default ES256. */
  bootstrapAlg?: "ES256" | "KS256";
}

/**
 * Normalize public key to 64 bytes (x || y) for ES256 grantData (Univocity contract).
 */
function publicKeyToGrantData64(keyBytes: Uint8Array): Uint8Array {
  if (keyBytes.length === 64) return keyBytes;
  if (keyBytes.length === 65 && keyBytes[0] === 0x04)
    return keyBytes.slice(1, 65);
  throw new Error(
    `Bootstrap public key must be 64 bytes (x||y) or 65 bytes (04||x||y) for ES256 grantData; got ${keyBytes.length}`,
  );
}

/** Request body for POST /api/grants/bootstrap (optional). */
export interface BootstrapMintBody {
  rootLogId?: string;
  logId?: string;
  /** Override alg (ES256 | KS256); default ES256. */
  alg?: string;
}

/**
 * Parse request body for optional rootLogId/logId. Returns undefined if body empty or missing.
 */
async function parseBootstrapBody(
  request: Request,
): Promise<BootstrapMintBody | undefined> {
  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) {
    return undefined;
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const rootLogId =
      typeof body?.rootLogId === "string" ? body.rootLogId : undefined;
    const logId = typeof body?.logId === "string" ? body.logId : undefined;
    const alg =
      typeof body?.alg === "string" ? body.alg.trim().toUpperCase() : undefined;
    if (!rootLogId && !logId && alg === undefined) return undefined;
    return {
      rootLogId: rootLogId ?? logId,
      logId: logId ?? rootLogId,
      alg: alg === "KS256" || alg === "ES256" ? alg : undefined,
    };
  } catch {
    return undefined;
  }
}

function normalizeBootstrapAlg(raw: string | undefined): "ES256" | "KS256" {
  const s = raw?.trim().toUpperCase();
  return s === "KS256" ? "KS256" : "ES256";
}

export async function handlePostBootstrapGrant(
  request: Request,
  env: BootstrapMintEnv,
): Promise<Response> {
  const body = await parseBootstrapBody(request);
  const rootLogIdRaw = body?.rootLogId ?? body?.logId ?? env.rootLogId?.trim();
  const alg = normalizeBootstrapAlg(body?.alg ?? env.bootstrapAlg);
  if (!rootLogIdRaw) {
    return ServerErrors.internal(
      "ROOT_LOG_ID not configured and request body has no rootLogId/logId",
    );
  }

  let logIdBytes: Uint8Array;
  try {
    logIdBytes = logIdToWireBytes(rootLogIdRaw);
  } catch (e) {
    return ClientErrors.badRequest(
      e instanceof Error ? e.message : "Invalid rootLogId or logId",
    );
  }
  const ownerLogIdBytes = logIdBytes.slice(0, 32);

  let grantData: Uint8Array;
  if (alg === "KS256") {
    return ServerErrors.internal(
      "KS256 bootstrap grantData not yet implemented; use ES256 for bootstrap grant",
    );
  }

  const custodianUrl = env.custodianUrl?.trim();
  if (!custodianUrl) {
    return ServerErrors.internal("CUSTODIAN_URL not configured");
  }

  try {
    const pk = await fetchCustodianPublicKey(
      custodianUrl,
      CUSTODIAN_BOOTSTRAP_KEY_ID,
    );
    if (pk.alg !== "ES256") {
      return ServerErrors.internal(
        `Bootstrap grant mint requires Custodian alg ES256; got ${pk.alg}`,
      );
    }
    const uncompressed = publicKeyPemToUncompressed65(pk.publicKeyPem);
    grantData = publicKeyToGrantData64(uncompressed);
  } catch (e) {
    return ServerErrors.badGateway(
      e instanceof Error ? e.message : "Bootstrap public key fetch failed",
    );
  }

  const grantBitmap = new Uint8Array(8);
  grantBitmap[4] = 0x03; // GF_CREATE | GF_EXTEND
  grantBitmap[7] = 0x01; // GF_AUTH_LOG
  const grant: Grant = {
    logId: logIdBytes,
    ownerLogId: ownerLogIdBytes,
    grant: grantBitmap,
    maxHeight: 0,
    minGrowth: 0,
    grantData,
  };

  const payloadBytes = encodeGrantPayload(grant);

  let sign1Raw: Uint8Array;
  try {
    sign1Raw = await postCustodianSignGrantPayload(
      custodianUrl,
      CUSTODIAN_BOOTSTRAP_KEY_ID,
      env.custodianBootstrapAppToken,
      payloadBytes,
    );
  } catch (e) {
    return ServerErrors.badGateway(
      e instanceof Error ? e.message : "Custodian bootstrap sign failed",
    );
  }

  let transparentStatement: Uint8Array;
  try {
    transparentStatement = mergeGrantHeadersIntoCustodianSign1(
      sign1Raw,
      payloadBytes,
    );
  } catch (e) {
    return ServerErrors.internal(
      e instanceof Error
        ? e.message
        : "Failed to assemble transparent statement",
    );
  }

  const base64 = btoa(String.fromCharCode(...transparentStatement));
  return new Response(base64, {
    status: 201,
    headers: {
      "Content-Type": "text/plain; charset=us-ascii",
    },
  });
}
