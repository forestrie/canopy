/**
 * HTTP handlers for the forestrie-ingress queue endpoints.
 *
 * These handlers are called by rangers via HTTP to pull entries and ack batches.
 * The DO RPC interface is used internally by canopy-api for enqueue.
 */

import { decode } from "cbor-x";
import type { Env } from "./env.js";
import type { PullRequest, AckRequest } from "@canopy/forestrie-ingress-types";
import {
  PROBLEM_TYPES,
  PROBLEM_CONTENT_TYPE,
} from "@canopy/forestrie-ingress-types";
import { encodePullResponse } from "./encoding.js";

/**
 * Create a Problem Details error response (RFC 9457).
 */
function problemResponse(
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
 * Get the global DO stub.
 */
function getQueueStub(env: Env) {
  const id = env.SEQUENCING_QUEUE.idFromName("global");
  return env.SEQUENCING_QUEUE.get(id);
}

/**
 * Parse request body as CBOR or JSON based on Content-Type.
 */
async function parseRequestBody<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("Content-Type") ?? "";

  if (contentType.includes("application/cbor")) {
    const buffer = await request.arrayBuffer();
    return decode(new Uint8Array(buffer)) as T;
  }

  // Default to JSON
  return (await request.json()) as T;
}

/**
 * Handle POST /queue/pull
 *
 * Request body (JSON or CBOR):
 * { pollerId: string, batchSize: number, visibilityMs: number }
 *
 * Response: CBOR-encoded PullResponse
 */
export async function handlePull(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const body = await parseRequestBody<PullRequest>(request);

    // Validate required fields
    if (!body.pollerId || typeof body.pollerId !== "string") {
      return problemResponse(
        400,
        PROBLEM_TYPES.INVALID_REQUEST,
        "Invalid request",
        "pollerId is required and must be a string",
      );
    }
    if (!body.batchSize || typeof body.batchSize !== "number" || body.batchSize <= 0) {
      return problemResponse(
        400,
        PROBLEM_TYPES.INVALID_REQUEST,
        "Invalid request",
        "batchSize is required and must be a positive number",
      );
    }
    if (!body.visibilityMs || typeof body.visibilityMs !== "number" || body.visibilityMs <= 0) {
      return problemResponse(
        400,
        PROBLEM_TYPES.INVALID_REQUEST,
        "Invalid request",
        "visibilityMs is required and must be a positive number",
      );
    }

    const stub = getQueueStub(env);
    const response = await stub.pull(body);

    // Encode as CBOR
    const encoded = encodePullResponse(response);

    return new Response(encoded, {
      status: 200,
      headers: { "Content-Type": "application/cbor" },
    });
  } catch (error) {
    console.error("Error in handlePull:", error);
    return problemResponse(
      500,
      PROBLEM_TYPES.INTERNAL_ERROR,
      "Internal error",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

/**
 * Handle POST /queue/ack
 *
 * Request body (JSON or CBOR):
 * { logId: ArrayBuffer (base64 in JSON), fromSeq: number, toSeq: number }
 *
 * Response: JSON { deleted: number }
 */
export async function handleAck(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const body = await parseRequestBody<AckRequest>(request);

    // Validate required fields
    if (!body.logId) {
      return problemResponse(
        400,
        PROBLEM_TYPES.INVALID_REQUEST,
        "Invalid request",
        "logId is required",
      );
    }
    if (typeof body.fromSeq !== "number" || body.fromSeq < 0) {
      return problemResponse(
        400,
        PROBLEM_TYPES.INVALID_REQUEST,
        "Invalid request",
        "fromSeq is required and must be a non-negative number",
      );
    }
    if (typeof body.toSeq !== "number" || body.toSeq < body.fromSeq) {
      return problemResponse(
        400,
        PROBLEM_TYPES.INVALID_REQUEST,
        "Invalid request",
        "toSeq is required and must be >= fromSeq",
      );
    }

    // Convert logId to ArrayBuffer if it came as base64 string (JSON case)
    // The type is ArrayBuffer per interface, but JSON may send base64 string
    const rawLogId = body.logId as ArrayBuffer | string | ArrayBufferView;
    let logIdBuffer: ArrayBuffer;
    if (typeof rawLogId === "string") {
      // Base64 decode
      const binary = atob(rawLogId);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      logIdBuffer = bytes.buffer;
    } else if (rawLogId instanceof ArrayBuffer) {
      logIdBuffer = rawLogId;
    } else if (ArrayBuffer.isView(rawLogId)) {
      // Copy to new ArrayBuffer to handle both ArrayBuffer and SharedArrayBuffer
      logIdBuffer = new Uint8Array(rawLogId.buffer, rawLogId.byteOffset, rawLogId.byteLength).slice().buffer;
    } else {
      return problemResponse(
        400,
        PROBLEM_TYPES.INVALID_REQUEST,
        "Invalid request",
        "logId must be base64 string or ArrayBuffer",
      );
    }

    const stub = getQueueStub(env);
    const result = await stub.ackRange(logIdBuffer, body.fromSeq, body.toSeq);

    return Response.json(result);
  } catch (error) {
    console.error("Error in handleAck:", error);
    return problemResponse(
      500,
      PROBLEM_TYPES.INTERNAL_ERROR,
      "Internal error",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

/**
 * Handle GET /queue/stats
 *
 * Response: JSON QueueStats
 */
export async function handleStats(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const stub = getQueueStub(env);
    const stats = await stub.stats();

    return Response.json(stats);
  } catch (error) {
    console.error("Error in handleStats:", error);
    return problemResponse(
      500,
      PROBLEM_TYPES.INTERNAL_ERROR,
      "Internal error",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}
