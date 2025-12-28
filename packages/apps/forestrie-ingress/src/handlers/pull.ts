/**
 * Handler for POST /queue/pull
 */

import type { Env } from "../env.js";
import type { PullRequest } from "@canopy/forestrie-ingress-types";
import { PROBLEM_TYPES } from "@canopy/forestrie-ingress-types";
import { encodePullResponse } from "../encoding.js";
import {
  problemResponse,
  internalError,
  getQueueStub,
  parseRequestBody,
} from "./handler.js";

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
    if (
      !body.batchSize ||
      typeof body.batchSize !== "number" ||
      body.batchSize <= 0
    ) {
      return problemResponse(
        400,
        PROBLEM_TYPES.INVALID_REQUEST,
        "Invalid request",
        "batchSize is required and must be a positive number",
      );
    }
    if (
      !body.visibilityMs ||
      typeof body.visibilityMs !== "number" ||
      body.visibilityMs <= 0
    ) {
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
    return internalError(error);
  }
}
