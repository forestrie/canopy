/**
 * Handler for POST /queue/ack
 *
 * Uses limit-based ack because sequence numbers are allocated globally across
 * all logs, making per-log seq values non-contiguous. See
 * arbor/docs/arc-cloudflare-do-ingress.md section 2.3.
 *
 * Request: CBOR { logId: ArrayBuffer, seqLo: number, limit: number }
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
    if (typeof body.seqLo !== "number" || body.seqLo < 0) {
      return problemResponse(
        400,
        PROBLEM_TYPES.INVALID_REQUEST,
        "Invalid request",
        "seqLo is required and must be a non-negative number",
      );
    }
    if (typeof body.limit !== "number" || body.limit < 0) {
      return problemResponse(
        400,
        PROBLEM_TYPES.INVALID_REQUEST,
        "Invalid request",
        "limit is required and must be a non-negative number",
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
    const result = await stub.ackFirst(logIdBuffer, body.seqLo, body.limit);

    return new Response(encodeAckResponse(result.deleted), {
      status: 200,
      headers: { "Content-Type": "application/cbor" },
    });
  } catch (error) {
    return internalError(error);
  }
}
