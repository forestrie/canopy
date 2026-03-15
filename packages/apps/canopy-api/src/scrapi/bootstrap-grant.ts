/**
 * Subplan 08 / Plan 0010: Bootstrap grant mint (no server-side storage).
 * POST /api/grants/bootstrap — build grant, sign via delegation-signer (COSE ToBeSigned),
 * return transparent statement in response body. Optional body { rootLogId } for per-log mint.
 * Caller is responsible for persisting the grant.
 */

import { encodeSigStructure } from "@canopy/encoding";
import { encode as encodeCbor } from "cbor-x";
import type { Grant } from "../grant/grant.js";
import { encodeGrantPayload } from "../grant/codec.js";
import { ClientErrors, ServerErrors } from "./problem-details.js";

/** COSE Sign1 protected = empty map (0xa0). */
const PROTECTED_EMPTY = new Uint8Array([0xa0]);
const IDTIMESTAMP_ZEROS = new Uint8Array(8);
const HEADER_IDTIMESTAMP = -65537;
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

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

export interface BootstrapMintEnv {
  /** Default when request body does not include rootLogId. */
  rootLogId?: string;
  delegationSignerUrl: string;
  delegationSignerBearerToken: string;
  /** Alg for bootstrap signing; default ES256. */
  bootstrapAlg?: "ES256" | "KS256";
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
async function parseBootstrapBody(request: Request): Promise<BootstrapMintBody | undefined> {
  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) {
    return undefined;
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const rootLogId = typeof body?.rootLogId === "string" ? body.rootLogId : undefined;
    const logId = typeof body?.logId === "string" ? body.logId : undefined;
    const alg = typeof body?.alg === "string" ? body.alg.trim().toUpperCase() : undefined;
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

/**
 * POST /api/grants/bootstrap — no auth required. Build bootstrap grant, call delegation-signer,
 * return transparent statement in response body (201, base64). No server-side storage.
 * Optional body: { "rootLogId": "<logId>" } or { "logId": "<logId>" } to mint for that log
 * instead of env ROOT_LOG_ID. logId may be 64 hex (32 bytes) or UUID (32 hex).
 */
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

  const grantFlags = new Uint8Array(8);
  grantFlags[4] = 0x03; // GF_CREATE | GF_EXTEND
  const grant: Grant = {
    version: 1,
    logId: logIdBytes,
    ownerLogId: ownerLogIdBytes,
    grantFlags,
    maxHeight: 0,
    minGrowth: 0,
    grantData: new Uint8Array(0),
    signer: new Uint8Array(32),
    kind: new Uint8Array([1]),
  };

  const payloadBytes = encodeGrantPayload(grant);
  const sigStructure = encodeSigStructure(
    PROTECTED_EMPTY,
    new Uint8Array(0),
    payloadBytes,
  );
  const digest = await crypto.subtle.digest("SHA-256", sigStructure);
  const coseTbsHash = bytesToHex(new Uint8Array(digest));

  const signerUrl = env.delegationSignerUrl?.trim().replace(/\/$/, "");
  if (!signerUrl) {
    return ServerErrors.internal("DELEGATION_SIGNER_URL not configured");
  }

  let signatureHex: string;
  try {
    const res = await fetch(`${signerUrl}/api/delegate/bootstrap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.delegationSignerBearerToken}`,
      },
      body: JSON.stringify({ cose_tbs_hash: coseTbsHash, alg }),
    });
    if (!res.ok) {
      const text = await res.text();
      return ServerErrors.badGateway(
        `Delegation-signer bootstrap failed: ${res.status} ${text}`,
      );
    }
    const data = (await res.json()) as { signature?: string };
    if (!data.signature?.trim()) {
      return ServerErrors.badGateway("Delegation-signer returned no signature");
    }
    signatureHex = data.signature.trim();
  } catch (e) {
    return ServerErrors.badGateway(
      e instanceof Error ? e.message : "Delegation-signer request failed",
    );
  }

  const sigHex = signatureHex.replace(/^0x/i, "").trim();
  if (sigHex.length !== 128 || !/^[0-9a-fA-F]+$/.test(sigHex)) {
    return ServerErrors.badGateway(
      "Delegation-signer signature must be 64 bytes (128 hex)",
    );
  }
  const signatureBytes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    signatureBytes[i] = parseInt(sigHex.slice(i * 2, i * 2 + 2), 16);
  }

  const unprotected = new Map<number, unknown>([
    [HEADER_IDTIMESTAMP, IDTIMESTAMP_ZEROS],
  ]);
  const coseSign1 = [PROTECTED_EMPTY, unprotected, payloadBytes, signatureBytes];
  const transparentStatement = new Uint8Array(encodeCbor(coseSign1));

  const base64 = btoa(String.fromCharCode(...transparentStatement));
  return new Response(base64, {
    status: 201,
    headers: {
      "Content-Type": "text/plain; charset=us-ascii",
    },
  });
}
