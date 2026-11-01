/**
 * Handler for POST /queue/ack
 *
 * Uses limit-based ack because sequence numbers are allocated globally across
 * all logs, making per-log seq values non-contiguous. See
 * arbor/docs/arc-cloudflare-do-ingress.md section 2.3.
 *
 * With return path unification (Phase 9), ack also records leaf indices
 * to enable direct registration status queries from the DO.
 *
 * Request: CBOR { logId, seqLo, limit, firstLeafIndex, massifHeight }
 * Response: CBOR { acked: number }
 *
 * firstLeafIndex is a uint64 (CBOR major type 0) from arbor's ranger and is
 * carried as `bigint`. A batch that runs past 2^64-1, or whose last leaf
 * would fall in a massif beyond MAX_MASSIF_INDEX, is rejected: go-merklelog
 * cannot write that massif, so the sequencing result could never resolve.
 */

import type { Env } from "../env.js";
import type { AckRequest } from "@canopy/forestrie-ingress-types";
import { PROBLEM_TYPES } from "@canopy/forestrie-ingress-types";
import { UINT64_MAX, toUint64 } from "@forestrie/encoding";
import {
  MAX_MASSIF_INDEX,
  massifIndexFromLeafIndex,
} from "@forestrie/merklelog";
import { encodeAckResponse } from "../encoding.js";
import {
  problemResponse,
  internalError,
  getQueueStub,
  getShardCount,
  parseCborBody,
} from "./handler.js";

export async function handleAck(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  try {
    // Parse and validate shard parameter (required)
    const shardParam = url.searchParams.get("shard");
    if (shardParam === null) {
      return problemResponse(
        400,
        PROBLEM_TYPES.INVALID_REQUEST,
        "Invalid request",
        "shard query parameter is required",
      );
    }
    const shardIndex = parseInt(shardParam, 10);
    const shardCount = getShardCount(env);
    if (isNaN(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
      return problemResponse(
        400,
        PROBLEM_TYPES.INVALID_REQUEST,
        "Invalid request",
        `shard must be an integer in range [0, ${shardCount - 1}]`,
      );
    }

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
    if (!Number.isSafeInteger(body.limit) || body.limit < 0) {
      return problemResponse(
        400,
        PROBLEM_TYPES.INVALID_REQUEST,
        "Invalid request",
        "limit is required and must be a non-negative number",
      );
    }
    let firstLeafIndex: bigint;
    try {
      firstLeafIndex = toUint64(body.firstLeafIndex, "firstLeafIndex");
    } catch {
      return problemResponse(
        400,
        PROBLEM_TYPES.INVALID_REQUEST,
        "Invalid request",
        "firstLeafIndex is required and must be a uint64 (CBOR major type 0)",
      );
    }
    // One-based height ranger commits at; the DO sizes retention from it.
    if (
      typeof body.massifHeight !== "number" ||
      !Number.isInteger(body.massifHeight) ||
      body.massifHeight < 1
    ) {
      return problemResponse(
        400,
        PROBLEM_TYPES.INVALID_REQUEST,
        "Invalid request",
        "massifHeight is required and must be a positive integer",
      );
    }

    const lastLeafIndex = firstLeafIndex + BigInt(Math.max(body.limit, 1) - 1);
    if (
      lastLeafIndex > UINT64_MAX ||
      massifIndexFromLeafIndex(body.massifHeight, lastLeafIndex) >
        MAX_MASSIF_INDEX
    ) {
      return problemResponse(
        400,
        PROBLEM_TYPES.INVALID_REQUEST,
        "Invalid request",
        `leaf index ${lastLeafIndex} at massif height ${body.massifHeight} ` +
          `is beyond the largest massif index (${MAX_MASSIF_INDEX})`,
      );
    }

    // CBOR gives us ArrayBuffer directly (or Uint8Array which we convert)
    const logIdBuffer =
      body.logId instanceof ArrayBuffer
        ? body.logId
        : new Uint8Array(
            (body.logId as Uint8Array).buffer,
            (body.logId as Uint8Array).byteOffset,
            (body.logId as Uint8Array).byteLength,
          ).slice().buffer;

    const stub = getQueueStub(env, shardIndex);
    const result = await stub.ackFirst(
      logIdBuffer,
      body.seqLo,
      body.limit,
      firstLeafIndex,
      body.massifHeight,
    );

    return new Response(encodeAckResponse(result.acked), {
      status: 200,
      headers: { "Content-Type": "application/cbor" },
    });
  } catch (error) {
    return internalError(error);
  }
}
