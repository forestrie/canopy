/**
 * Grant auth primitives: get grant from request (Authorization: Forestrie-Grant) and
 * authorize (receipt MMR + {@link verifyGrantIncluded} on **`grant.ownerLogId`** when
 * `inclusionEnv` is passed; the HTTP worker passes it whenever **`SEQUENCING_QUEUE`** is bound). Plan 0005:
 * caller supplies transparent statement only; receipt from artifact. Optional env exists for direct tests
 * without queue bindings — not a public client concern.
 */

import type { GrantResult } from "../grant/types.js";
import { decodeTransparentStatement } from "../grant/transparent-statement.js";
import { verifyReceiptInclusionFromParsed } from "../grant/receipt-verify.js";
import { logIdBytesToCustodianLowerHex } from "../grant/uuid-bytes.js";
import type { ReceiptVerifyKeyResolver } from "../env/receipt-verify-key-resolver.js";
import {
  verifyGrantIncluded,
  type InclusionEnv,
} from "./verify-grant-inclusion.js";
import { CBOR_CONTENT_TYPES } from "../cbor-api/cbor-content-types.js";
import { cborResponse } from "../cbor-api/cbor-response.js";
import { ClientErrors, ServerErrors } from "../cbor-api/problem-details.js";

const FORESTRIE_GRANT_SCHEME = "Forestrie-Grant";

function unauthorizedGrantRequired(): Response {
  return cborResponse(
    {
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail:
        "Grant required. Supply Authorization: Forestrie-Grant <base64> (transparent statement).",
      reason: "grant_required",
    },
    401,
    { "Content-Type": CBOR_CONTENT_TYPES.PROBLEM_CBOR },
  );
}

/** Env for receipt-based authorization (inclusion verification). */
export interface AuthGrantAuthorizeEnv {
  /** When set, grant must pass receipt-based inclusion verification. */
  inclusionEnv?: InclusionEnv;
  /**
   * Resolves ES256 verify key for receipt Sign1 (Custodian curator/log-key path).
   * Required when `inclusionEnv` is set.
   */
  resolveReceiptVerifyKey?: ReceiptVerifyKeyResolver;
}

/**
 * Get grant from request (Plan 0005).
 * Reads Authorization: Forestrie-Grant <base64>; base64-decode → COSE-decode → GrantResult
 * (grant from payload, idtimestamp from header -65537, receipt from header 396). No fetch.
 *
 * @returns GrantResult or a Response to return (401 missing/wrong scheme, 400/403 invalid).
 */
export function getGrantFromRequest(request: Request): GrantResult | Response {
  const auth = request.headers.get("Authorization");
  if (!auth || typeof auth !== "string") {
    return unauthorizedGrantRequired();
  }
  const trimmed = auth.trim();
  const prefix = `${FORESTRIE_GRANT_SCHEME} `;
  if (!trimmed.startsWith(prefix)) {
    return unauthorizedGrantRequired();
  }
  const token = trimmed.slice(prefix.length).trim();
  if (!token) {
    return unauthorizedGrantRequired();
  }
  let bytes: Uint8Array;
  try {
    const binary = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
  } catch {
    return ClientErrors.badRequest("Grant value is not valid base64.");
  }
  try {
    return decodeTransparentStatement(bytes);
  } catch (e) {
    const msg =
      e instanceof Error ? e.message : "Invalid transparent statement";
    return ClientErrors.badRequest(msg);
  }
}

/**
 * Verify that the grant receipt is valid when inclusionEnv is set (Plan 0005).
 * Uses grantResult.grant and grantResult.receipt only; no request; no fetch.
 *
 * @returns null if valid (or when inclusionEnv is omitted — callers such as Vitest without queue stubs);
 * otherwise a Response (403) to return.
 */
export async function grantAuthorize(
  grantResult: GrantResult,
  env: AuthGrantAuthorizeEnv,
): Promise<Response | null> {
  if (!env.inclusionEnv) return null;

  if (grantResult.receipt == null) {
    return ClientErrors.forbidden(
      "Grant artifact must be a SCITT transparent statement with receipt (unprotected header 396) when inclusion is required.",
    );
  }

  const { grant, idtimestamp, receipt } = grantResult;
  if (!idtimestamp || idtimestamp.length < 8) {
    return ClientErrors.forbidden(
      "Grant must be completed (idtimestamp required for receipt verification).",
    );
  }

  if (!env.resolveReceiptVerifyKey) {
    return ServerErrors.serviceUnavailable(
      "Receipt verification key resolver is not configured.",
    );
  }

  let receiptVerifyKey: CryptoKey;
  try {
    receiptVerifyKey = await env.resolveReceiptVerifyKey(
      logIdBytesToCustodianLowerHex(grant.ownerLogId),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/\b404\b/.test(msg)) {
      return ClientErrors.forbidden(
        "Cannot resolve receipt verification key for this log (Custodian).",
      );
    }
    console.warn("resolveReceiptVerifyKey failed", e);
    return ServerErrors.serviceUnavailable(
      msg.length > 200 ? `${msg.slice(0, 200)}…` : msg,
    );
  }

  if (!receipt.coseSign1Bytes?.length) {
    return ClientErrors.forbidden(
      "Grant receipt is missing raw COSE Sign1 bytes for verification.",
    );
  }

  const valid = await verifyReceiptInclusionFromParsed(
    grant,
    idtimestamp,
    receipt.explicitPeak,
    receipt.proof,
    {
      receiptCoseBytes: receipt.coseSign1Bytes,
      receiptVerifyKey,
    },
  );
  if (!valid) {
    return ClientErrors.forbidden(
      "Grant receipt verification failed (receipt signature or inclusion proof).",
    );
  }

  const onOwnerQueue = await verifyGrantIncluded(grant, env.inclusionEnv);
  if (!onOwnerQueue) {
    return ClientErrors.forbidden(
      "Grant commitment is not recorded on the owner log sequencing queue.",
    );
  }

  return null;
}
