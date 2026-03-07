/**
 * Grant-based auth for register-statement (Plan 0001 Step 5).
 * Locate grant location from request, retrieve from R2, verify statement signer matches grant.
 */

import { decode as decodeCbor } from "cbor-x";
import { decodeGrant } from "../grant/codec.js";
import type { Grant } from "../grant/types.js";
import { cborResponse } from "./cbor-response";
import { CBOR_CONTENT_TYPES } from "./cbor-content-types";

/** Header for grant location (URL path only). */
export const GRANT_LOCATION_HEADER = "X-Grant-Location";

/**
 * Get grant location from request. Prefer X-Grant-Location; fallback Authorization: Bearer <path>.
 * Returns URL path only (e.g. /attestor/abc123.cbor) or null if missing/malformed.
 */
export function getGrantLocationFromRequest(request: Request): string | null {
  const fromHeader = request.headers.get(GRANT_LOCATION_HEADER);
  if (fromHeader) {
    const path = fromHeader.trim();
    if (path.startsWith("/") && !path.includes("://")) return path;
    return null;
  }
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const path = auth.slice(7).trim();
    if (path.startsWith("/") && !path.includes("://")) return path;
    return null;
  }
  return null;
}

/**
 * Resolve path to R2 key: strip leading slash (path-only is relative to bucket root).
 */
export function pathToStorageKey(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

/**
 * Fetch grant from R2. Returns null if not found or error.
 */
export async function fetchGrant(
  r2Grants: R2Bucket,
  path: string,
): Promise<{ grant: Grant; bytes: Uint8Array } | null> {
  const key = pathToStorageKey(path);
  const obj = await r2Grants.get(key);
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  try {
    const grant = decodeGrant(bytes);
    return { grant, bytes };
  } catch {
    return null;
  }
}

/** COSE header label for key id (kid). */
const COSE_KID = 4;

/**
 * Extract signer (kid) from COSE Sign1 bytes. Returns Uint8Array of kid if present, else null.
 */
export function getSignerFromCoseSign1(coseSign1Bytes: Uint8Array): Uint8Array | null {
  let arr: unknown[];
  try {
    arr = decodeCbor(coseSign1Bytes) as unknown[];
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length < 4) return null;
  const protectedBstr = arr[0];
  if (!(protectedBstr instanceof Uint8Array)) return null;
  let protectedMap: Record<number, unknown> | Map<number, unknown>;
  try {
    protectedMap = decodeCbor(protectedBstr) as Record<number, unknown> | Map<number, unknown>;
  } catch {
    return null;
  }
  const kid = protectedMap instanceof Map
    ? protectedMap.get(COSE_KID)
    : (protectedMap as Record<number, unknown>)[COSE_KID];
  if (kid instanceof Uint8Array) return kid;
  if (typeof kid === "string") return new TextEncoder().encode(kid);
  return null;
}

/**
 * Compare statement signer with grant signer binding (byte equality).
 */
export function signerMatchesGrant(
  statementSigner: Uint8Array | null,
  grantSigner: Uint8Array,
): boolean {
  if (!statementSigner || statementSigner.length !== grantSigner.length) return false;
  for (let i = 0; i < grantSigner.length; i++) {
    if (statementSigner[i] !== grantSigner[i]) return false;
  }
  return true;
}

/** Problem detail body for grant auth failures (Concise Problem Details, CBOR). */
function grantAuthProblem(
  status: 401 | 402 | 403,
  title: string,
  detail: string,
  reason?: string,
): Response {
  const body: Record<string, unknown> = {
    type: "about:blank",
    title,
    status,
    detail,
  };
  if (reason) body.reason = reason;
  return cborResponse(body, status, {
    "content-type": CBOR_CONTENT_TYPES.PROBLEM_CBOR,
  });
}

export const GrantAuthErrors = {
  grantRequired: () =>
    grantAuthProblem(
      401,
      "Unauthorized",
      "Grant location required. Supply X-Grant-Location or Authorization: Bearer <path> with a URL path to the grant.",
      "grant_required",
    ),
  grantLocationInvalid: () =>
    grantAuthProblem(
      401,
      "Unauthorized",
      "Grant location must be a URL path only (e.g. /kind/hash.cbor).",
      "grant_location_invalid",
    ),
  grantNotFound: () =>
    grantAuthProblem(
      401,
      "Unauthorized",
      "Grant not found at the given location.",
      "grant_not_found",
    ),
  grantInvalid: () =>
    grantAuthProblem(
      401,
      "Unauthorized",
      "Grant document is invalid or corrupted.",
      "grant_invalid",
    ),
  signerMismatch: () =>
    grantAuthProblem(
      403,
      "Forbidden",
      "Statement signer does not match the grant's signer binding.",
      "signer_mismatch",
    ),
};
