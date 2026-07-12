/**
 * Shared HTTP helpers for delegation-coordinator route handlers.
 *
 * Upstream: index.ts route table. Downstream: sharded
 * {@link DelegationStoreDO} via {@link forwardToStore}. Log id normalization
 * aligns with [arbor sealer](https://github.com/forestrie/arbor/blob/main/services/sealer/)
 * wire formats and CBOR bodies from delegation issue flows per
 * [ARC-0017](https://github.com/forestrie/devdocs/blob/main/arc/arc-0017-hierarchical-authority-logs-and-fee-distribution.md).
 */

import { decode } from "cbor-x";
import { encodeCborDeterministic } from "@forestrie/encoding";
import type { Env } from "../env.js";
import { hex32ToCanonicalUuid, normalizeLogIdToHex32 } from "../log-id.js";
import {
  shardIndexForLog,
  shardNameForIndex,
} from "@canopy/forestrie-sharding";

/** Expected Content-Type for CBOR request/response bodies. */
const CBOR_CONTENT_TYPE = "application/cbor";

/** Content-Type for JSON RFC 7807 problem responses. */
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/**
 * Build a JSON RFC 7807 problem response.
 *
 * @param status - HTTP status code.
 * @param type - Problem type URI (often `about:blank`).
 * @param title - Short human-readable title.
 * @param detail - Optional longer explanation.
 * @returns JSON Response with {@link PROBLEM_CONTENT_TYPE}.
 */
export function problemResponse(
  status: number,
  type: string,
  title: string,
  detail?: string,
): Response {
  return Response.json(
    { type, title, status, detail },
    {
      status,
      headers: { "Content-Type": PROBLEM_CONTENT_TYPE },
    },
  );
}

/**
 * Log and return a generic 500 problem response.
 *
 * @param error - Caught exception or unknown value.
 * @returns 500 JSON problem Response.
 */
export function internalError(error: unknown): Response {
  console.error("Internal error:", error);
  return problemResponse(
    500,
    "about:blank",
    "Internal error",
    error instanceof Error ? error.message : "Unknown error",
  );
}

/**
 * Parse {@link Env.COORDINATOR_SHARD_COUNT} with fallback to 1.
 *
 * @param env - Worker bindings.
 * @returns Positive shard count for DO routing.
 */
export function getShardCount(env: Env): number {
  const count = parseInt(env.COORDINATOR_SHARD_COUNT, 10);
  if (isNaN(count) || count < 1) {
    console.error(
      `Invalid COORDINATOR_SHARD_COUNT: ${env.COORDINATOR_SHARD_COUNT}, using 1`,
    );
    return 1;
  }
  return count;
}

/**
 * Resolve a {@link DelegationStoreDO} stub by shard index.
 *
 * @param env - Worker bindings.
 * @param shardIndex - Zero-based shard index.
 * @returns Durable Object stub for internal fetch calls.
 */
export function getStoreStub(env: Env, shardIndex: number) {
  const shardName = shardNameForIndex(shardIndex);
  const id = env.DELEGATION_STORE.idFromName(shardName);
  return env.DELEGATION_STORE.get(id);
}

/**
 * Route a log id to its sharded {@link DelegationStoreDO} stub.
 *
 * @param env - Worker bindings.
 * @param logIdHex32 - Normalized 32-char hex log id.
 * @returns Durable Object stub owning persistence for the log.
 */
export function getStoreStubForLogId(env: Env, logIdHex32: string) {
  const shardCount = getShardCount(env);
  const uuid = hex32ToCanonicalUuid(logIdHex32);
  const shardIndex = shardIndexForLog(uuid, shardCount);
  return getStoreStub(env, shardIndex);
}

/**
 * Normalize a path log id segment or return a 400 problem.
 *
 * @param logIdSegment - Raw URL path segment (UUID or hex).
 * @returns Normalized hex32 string or error Response.
 */
export function normalizePathLogId(logIdSegment: string): string | Response {
  try {
    return normalizeLogIdToHex32(logIdSegment);
  } catch (error) {
    return problemResponse(
      400,
      "about:blank",
      "Invalid request",
      error instanceof Error ? error.message : "Invalid logId",
    );
  }
}

/**
 * Decode a CBOR request body after Content-Type check.
 *
 * @param request - Incoming HTTP request.
 * @returns Parsed body or 415 problem Response.
 */
export async function parseCborBody<T>(
  request: Request,
): Promise<T | Response> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes(CBOR_CONTENT_TYPE)) {
    return problemResponse(
      415,
      "about:blank",
      "Unsupported Media Type",
      "Content-Type must be application/cbor",
    );
  }
  const buffer = await request.arrayBuffer();
  return decode(new Uint8Array(buffer)) as T;
}

/**
 * Encode a value as a CBOR 200 response.
 *
 * @param value - Serializable CBOR value.
 * @returns Response with `application/cbor`.
 */
export function encodeCborResponse(value: unknown): Response {
  const encoded = encodeCborDeterministic(value);
  const bytes =
    encoded instanceof Uint8Array
      ? encoded
      : new Uint8Array(encoded as ArrayLike<number>);
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Type": CBOR_CONTENT_TYPE },
  });
}

/**
 * Encode an RFC 7807 problem document as CBOR.
 *
 * @param status - HTTP status code.
 * @param title - Problem title.
 * @param detail - Optional detail string.
 * @returns CBOR problem Response.
 */
export function encodeCborError(
  status: number,
  title: string,
  detail?: string,
): Response {
  const body = encodeCborDeterministic({
    type: "about:blank",
    title,
    status,
    detail,
  });
  const bytes =
    body instanceof Uint8Array
      ? body
      : new Uint8Array(body as ArrayLike<number>);
  return new Response(bytes, {
    status,
    headers: { "Content-Type": "application/problem+cbor" },
  });
}

/**
 * Forward an internal request to the sharded store for a log.
 *
 * @param env - Worker bindings.
 * @param logIdHex32 - Normalized log id for shard selection.
 * @param path - Path on the DO internal URL (e.g. `/issue`).
 * @param init - Optional fetch init (method, body, headers).
 * @returns Response from the Durable Object.
 */
export async function forwardToStore(
  env: Env,
  logIdHex32: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const stub = getStoreStubForLogId(env, logIdHex32);
  return stub.fetch(`https://do.internal${path}`, init);
}
