/**
 * Common handler utilities for forestrie-ingress HTTP endpoints.
 */

import { decode } from "cbor-x";
import type { Env } from "../env.js";
import {
  PROBLEM_TYPES,
  PROBLEM_CONTENT_TYPE,
} from "@canopy/forestrie-ingress-types";

/**
 * Create a Problem Details error response (RFC 9457).
 */
export function problemResponse(
  status: number,
  type: string,
  title: string,
  detail?: string,
): Response {
  return new Response(
    JSON.stringify({
      type,
      title,
      status,
      detail,
    }),
    {
      status,
      headers: { "Content-Type": PROBLEM_CONTENT_TYPE },
    },
  );
}

/**
 * Create a standard internal error response.
 */
export function internalError(error: unknown): Response {
  console.error("Internal error:", error);
  return problemResponse(
    500,
    PROBLEM_TYPES.INTERNAL_ERROR,
    "Internal error",
    error instanceof Error ? error.message : "Unknown error",
  );
}

/**
 * Get the global DO stub.
 */
export function getQueueStub(env: Env) {
  const id = env.SEQUENCING_QUEUE.idFromName("global");
  return env.SEQUENCING_QUEUE.get(id);
}

/**
 * Parse request body as CBOR or JSON based on Content-Type.
 */
export async function parseRequestBody<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("Content-Type") ?? "";

  if (contentType.includes("application/cbor")) {
    const buffer = await request.arrayBuffer();
    return decode(new Uint8Array(buffer)) as T;
  }

  // Default to JSON
  return (await request.json()) as T;
}
