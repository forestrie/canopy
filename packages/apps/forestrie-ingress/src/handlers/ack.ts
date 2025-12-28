/**
 * Handler for POST /queue/ack
 */

import type { Env } from "../env.js";
import type { AckRequest } from "@canopy/forestrie-ingress-types";
import { PROBLEM_TYPES } from "@canopy/forestrie-ingress-types";
import {
  problemResponse,
  internalError,
  getQueueStub,
  parseRequestBody,
} from "./handler.js";

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
      logIdBuffer = new Uint8Array(
        rawLogId.buffer,
        rawLogId.byteOffset,
        rawLogId.byteLength,
      ).slice().buffer;
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
    return internalError(error);
  }
}
