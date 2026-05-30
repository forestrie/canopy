import { encode } from "cbor-x";

export const DELEGATION_PENDING_RETRY_AFTER_SECONDS = 5;

export const DELEGATION_PENDING_DETAIL =
  "delegation material not found for requested range and key";

export function delegationPendingCborProblem(status: 202 | 503): Uint8Array {
  const problem = encode({
    type: "about:blank",
    title: status === 202 ? "Accepted" : "Service Unavailable",
    status,
    detail: DELEGATION_PENDING_DETAIL,
  });
  return problem instanceof Uint8Array
    ? problem
    : new Uint8Array(problem as ArrayLike<number>);
}

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
