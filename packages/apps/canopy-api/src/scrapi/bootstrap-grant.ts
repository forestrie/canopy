/**
 * Subplan 08: Bootstrap grant mint and well-known GET.
 * POST /api/grants/bootstrap — build grant, sign via delegation-signer, store at well-known path.
 * GET /grants/bootstrap or /grants/authority/:rootLogId/bootstrap — serve bootstrap grant.
 */

import { encodeGrant } from "../grant/codec.js";
import { innerHashFromGrant } from "../grant/inner-hash.js";
import type { Grant } from "../grant/types.js";
import { ClientErrors, ServerErrors } from "./problem-details.js";

const BOOTSTRAP_STORAGE_PREFIX = "bootstrap";

/** Stored bootstrap doc: grant bytes (as array) + signature hex for verification. */
export interface BootstrapGrantDoc {
  grant: number[];
  signature: string;
}

export interface BootstrapMintEnv {
  r2Grants: R2Bucket;
  rootLogId: string;
  delegationSignerUrl: string;
  delegationSignerBearerToken: string;
}

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
 * POST /api/grants/bootstrap — no auth required. Build grant, call delegation-signer, store, return 201.
 */
export async function handlePostBootstrapGrant(
  _request: Request,
  env: BootstrapMintEnv,
): Promise<Response> {
  const rootLogId = env.rootLogId?.trim();
  if (!rootLogId) {
    return ServerErrors.internal("ROOT_LOG_ID not configured");
  }

  const logIdBytes = hexToBytes32(rootLogId);
  const ownerLogIdBytes = logIdBytes.slice(0, 32);
  const grantFlags = new Uint8Array(8);
  grantFlags[4] = 0x03; // GF_CREATE | GF_EXTEND
  const grant: Grant = {
    version: 1,
    idtimestamp: new Uint8Array(8),
    logId: logIdBytes,
    ownerLogId: ownerLogIdBytes,
    grantFlags,
    maxHeight: 0,
    minGrowth: 0,
    grantData: new Uint8Array(0),
    signer: new Uint8Array(32),
    kind: new Uint8Array([1]),
  };

  const inner = await innerHashFromGrant(grant);
  const payloadHash = Array.from(inner)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const signerUrl = env.delegationSignerUrl?.trim().replace(/\/$/, "");
  if (!signerUrl) {
    return ServerErrors.internal("DELEGATION_SIGNER_URL not configured");
  }

  let signature: string;
  try {
    const res = await fetch(`${signerUrl}/api/delegate/bootstrap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.delegationSignerBearerToken}`,
      },
      body: JSON.stringify({ payload_hash: payloadHash }),
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
    signature = data.signature.trim();
  } catch (e) {
    return ServerErrors.badGateway(
      e instanceof Error ? e.message : "Delegation-signer request failed",
    );
  }

  const storagePath = `${BOOTSTRAP_STORAGE_PREFIX}/${rootLogId.replace(/^0x/i, "").toLowerCase()}.cbor`;
  const existing = await env.r2Grants.get(storagePath);
  if (existing) {
    const location = `/grants/${BOOTSTRAP_STORAGE_PREFIX}/${rootLogId.replace(/^0x/i, "").toLowerCase()}`;
    return new Response(null, {
      status: 200,
      headers: {
        Location: location,
        "Content-Type": "application/cbor",
      },
    });
  }

  const grantWithPlaceholder: Grant = { ...grant, idtimestamp: new Uint8Array(8) };
  const encoded = encodeGrant(grantWithPlaceholder);
  const doc: BootstrapGrantDoc = { grant: Array.from(encoded), signature };
  const docBytes = new TextEncoder().encode(JSON.stringify(doc));
  await env.r2Grants.put(storagePath, docBytes, {
    httpMetadata: { contentType: "application/cbor" },
  });

  const location = `/grants/${BOOTSTRAP_STORAGE_PREFIX}/${rootLogId.replace(/^0x/i, "").toLowerCase()}`;
  return new Response(null, {
    status: 201,
    headers: {
      Location: location,
      "Content-Type": "application/cbor",
    },
  });
}

export interface ServeBootstrapEnv {
  r2Grants: R2Bucket;
}

/**
 * GET well-known bootstrap grant. Returns 200 with grant CBOR (grant part only) or 404.
 */
export async function serveBootstrapGrant(
  rootLogId: string,
  env: ServeBootstrapEnv,
): Promise<Response> {
  const key = rootLogId.replace(/^0x/i, "").toLowerCase();
  if (key.length !== 64 || !/^[0-9a-f]+$/.test(key)) {
    return ClientErrors.badRequest("rootLogId must be 64 hex characters");
  }
  const storagePath = `${BOOTSTRAP_STORAGE_PREFIX}/${key}.cbor`;
  const obj = await env.r2Grants.get(storagePath);
  if (!obj) {
    return new Response(null, { status: 404 });
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  let doc: BootstrapGrantDoc;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes)) as BootstrapGrantDoc;
  } catch {
    return ServerErrors.internal("Bootstrap grant document invalid");
  }
  if (!doc.grant?.length) {
    return ServerErrors.internal("Bootstrap grant document missing grant");
  }
  const grantBytes = new Uint8Array(doc.grant);
  return new Response(grantBytes, {
    status: 200,
    headers: { "Content-Type": "application/cbor" },
  });
}

/**
 * Fetch bootstrap grant document (grant + signature) for auth verification.
 * Path must be /grants/bootstrap or /grants/bootstrap/{rootLogId}.
 */
export async function fetchBootstrapGrantWithSignature(
  r2Grants: R2Bucket,
  path: string,
  rootLogId: string,
): Promise<{ grant: import("../grant/types.js").Grant; signature: string } | null> {
  const normalized = path.replace(/^\/+/, "").split("/");
  if (
    normalized[0] !== "grants" ||
    normalized[1] !== BOOTSTRAP_STORAGE_PREFIX
  ) {
    return null;
  }
  const keyParam = normalized[2];
  const key = keyParam
    ? `${BOOTSTRAP_STORAGE_PREFIX}/${keyParam.replace(/^0x/i, "").toLowerCase()}.cbor`
    : `${BOOTSTRAP_STORAGE_PREFIX}/${rootLogId.replace(/^0x/i, "").toLowerCase()}.cbor`;
  const obj = await r2Grants.get(key);
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  try {
    const doc = JSON.parse(new TextDecoder().decode(bytes)) as BootstrapGrantDoc;
    if (!doc.grant?.length || !doc.signature?.trim()) return null;
    const { decodeGrant } = await import("../grant/codec.js");
    const grant = decodeGrant(new Uint8Array(doc.grant));
    return { grant, signature: doc.signature.trim() };
  } catch {
    return null;
  }
}
