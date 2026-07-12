/**
 * CBOR problem responses for pending delegation (202 Accepted / 503).
 *
 * Returned by {@link DelegationStoreDO} issue path and POST /api/delegations
 * when certificate material is not yet available; includes Retry-After for
 * [arbor sealer](https://github.com/forestrie/arbor/blob/main/services/sealer/)
 * polling backoff.
 */

import { encodeCbor } from "./cbor.js";

/** Retry-After seconds on 202 pending responses. */
export const DELEGATION_PENDING_RETRY_AFTER_SECONDS = 5;

/** Stable problem detail for missing delegation material. */
export const DELEGATION_PENDING_DETAIL =
  "delegation material not found for requested range and key";

/**
 * Encode RFC 7807 problem document as CBOR bytes.
 *
 * @param status - 202 Accepted or 503 Service Unavailable.
 */
export function delegationPendingCborProblem(status: 202 | 503): Uint8Array {
  return encodeCbor({
    type: "about:blank",
    title: status === 202 ? "Accepted" : "Service Unavailable",
    status,
    detail: DELEGATION_PENDING_DETAIL,
  });
}

/**
 * Build HTTP Response for pending delegation surfacing.
 *
 * @param status - 202 with Retry-After, or 503 when disabled/unavailable.
 * @returns CBOR problem Response.
 */
export function delegationPendingResponse(status: 202 | 503): Response {
  const bytes = delegationPendingCborProblem(status);
  const headers: Record<string, string> = {
    "Content-Type": "application/problem+cbor",
  };
  if (status === 202) {
    headers["Retry-After"] = String(DELEGATION_PENDING_RETRY_AFTER_SECONDS);
  }
  return new Response(bytes, { status, headers });
}
