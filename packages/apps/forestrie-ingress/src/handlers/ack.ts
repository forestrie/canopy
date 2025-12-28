/**
 * Handler for POST /queue/ack
 *
 * Request: CBOR { logId: ArrayBuffer, fromSeq: number, toSeq: number }
 * Response: CBOR { deleted: number }
 */

import type { Env } from "../env.js";
import type { AckRequest } from "@canopy/forestrie-ingress-types";
import { PROBLEM_TYPES } from "@canopy/forestrie-ingress-types";
import { encodeAckResponse } from "../encoding.js";
import {
  problemResponse,
  internalError,
  getQueueStub,
  parseCborBody,
} from "./handler.js";

export async function handleAck(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const body = await parseCborBody<AckRequest>(request);
    if (body instanceof Response) return body;

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

    // CBOR gives us ArrayBuffer directly (or Uint8Array which we convert)
    const logIdBuffer = body.logId instanceof ArrayBuffer
      ? body.logId
      : new Uint8Array(
          (body.logId as Uint8Array).buffer,
          (body.logId as Uint8Array).byteOffset,
          (body.logId as Uint8Array).byteLength,
        ).slice().buffer;

    const stub = getQueueStub(env);
    const result = await stub.ackRange(logIdBuffer, body.fromSeq, body.toSeq);

    return new Response(encodeAckResponse(result.deleted), {
      status: 200,
      headers: { "Content-Type": "application/cbor" },
    });
  } catch (error) {
    return internalError(error);
  }
}
