/**
 * Subplan 08: Bootstrap grant mint and well-known GET.
 * POST /api/grants/bootstrap — build grant, sign via delegation-signer (COSE ToBeSigned),
 * return transparent statement; store as .cose.
 * GET /grants/bootstrap/:rootLogId — serve bootstrap transparent statement.
 */

import { encodeSigStructure } from "@canopy/encoding";
import { encode as encodeCbor } from "cbor-x";
import type { Grant } from "../grant/grant.js";
import { encodeGrantPayload } from "../grant/codec.js";
import { ClientErrors, ServerErrors } from "./problem-details.js";

const BOOTSTRAP_STORAGE_PREFIX = "bootstrap";
/** COSE Sign1 protected = empty map (0xa0). */
const PROTECTED_EMPTY = new Uint8Array([0xa0]);
const IDTIMESTAMP_ZEROS = new Uint8Array(8);
const HEADER_IDTIMESTAMP = -65537;

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

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

export interface BootstrapMintEnv {
  r2Grants: R2Bucket;
  rootLogId: string;
  delegationSignerUrl: string;
  delegationSignerBearerToken: string;
}

/**
 * POST /api/grants/bootstrap — no auth required. Build bootstrap grant, build COSE ToBeSigned,
 * call delegation-signer with cose_tbs_hash, assemble transparent statement, store and return it.
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
      body: JSON.stringify({ cose_tbs_hash: coseTbsHash }),
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
    return ServerErrors.badGateway("Delegation-signer signature must be 64 bytes (128 hex)");
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

  const key = rootLogId.replace(/^0x/i, "").toLowerCase();
  const storagePath = `${BOOTSTRAP_STORAGE_PREFIX}/${key}.cose`;
  const existing = await env.r2Grants.get(storagePath);
  if (existing) {
    const location = `/grants/${BOOTSTRAP_STORAGE_PREFIX}/${key}`;
    return new Response(null, {
      status: 200,
      headers: {
        Location: location,
        "Content-Type": "application/cose",
      },
    });
  }

  await env.r2Grants.put(storagePath, transparentStatement, {
    httpMetadata: { contentType: "application/cose" },
  });

  const location = `/grants/${BOOTSTRAP_STORAGE_PREFIX}/${key}`;
  const base64 = btoa(
    String.fromCharCode(...transparentStatement),
  );
  return new Response(base64, {
    status: 201,
    headers: {
      Location: location,
      "Content-Type": "text/plain; charset=us-ascii",
    },
  });
}

export interface ServeBootstrapEnv {
  r2Grants: R2Bucket;
}

/**
 * GET well-known bootstrap grant. Returns 200 with transparent statement (COSE) body or 404.
 */
export async function serveBootstrapGrant(
  rootLogId: string,
  env: ServeBootstrapEnv,
): Promise<Response> {
  const key = rootLogId.replace(/^0x/i, "").toLowerCase();
  if (key.length !== 64 || !/^[0-9a-f]+$/.test(key)) {
    return ClientErrors.badRequest("rootLogId must be 64 hex characters");
  }
  const storagePath = `${BOOTSTRAP_STORAGE_PREFIX}/${key}.cose`;
  const obj = await env.r2Grants.get(storagePath);
  if (!obj) {
    return new Response(null, { status: 404 });
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Type": "application/cose" },
  });
}
