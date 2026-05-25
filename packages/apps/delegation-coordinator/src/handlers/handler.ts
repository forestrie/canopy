/**
 * Common handler utilities for delegation-coordinator HTTP endpoints.
 */

import { decode, encode } from "cbor-x";
import type { Env } from "../env.js";
import { hex32ToCanonicalUuid, normalizeLogIdToHex32 } from "../log-id.js";
import {
  shardIndexForLog,
  shardNameForIndex,
} from "@canopy/forestrie-sharding";

const CBOR_CONTENT_TYPE = "application/cbor";
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

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

export function internalError(error: unknown): Response {
  console.error("Internal error:", error);
  return problemResponse(
    500,
    "about:blank",
    "Internal error",
    error instanceof Error ? error.message : "Unknown error",
  );
}

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

export function getStoreStub(env: Env, shardIndex: number) {
  const shardName = shardNameForIndex(shardIndex);
  const id = env.DELEGATION_STORE.idFromName(shardName);
  return env.DELEGATION_STORE.get(id);
}

export function getStoreStubForLogId(env: Env, logIdHex32: string) {
  const shardCount = getShardCount(env);
  const uuid = hex32ToCanonicalUuid(logIdHex32);
  const shardIndex = shardIndexForLog(uuid, shardCount);
  return getStoreStub(env, shardIndex);
}

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

export function encodeCborResponse(value: unknown): Response {
  const encoded = encode(value);
  const bytes =
    encoded instanceof Uint8Array
      ? encoded
      : new Uint8Array(encoded as ArrayLike<number>);
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Type": CBOR_CONTENT_TYPE },
  });
}

export function encodeCborError(
  status: number,
  title: string,
  detail?: string,
): Response {
  const body = encode({
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

export async function forwardToStore(
  env: Env,
  logIdHex32: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const stub = getStoreStubForLogId(env, logIdHex32);
  return stub.fetch(`https://do.internal${path}`, init);
}
