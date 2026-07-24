/**
 * GET /api/logs/{logId}/public-root — CBOR trust-root (public read).
 *
 * Wire format matches sealer/univocity public root conventions.
 */

import type { Env } from "../env.js";
import {
  forwardToStore,
  internalError,
  normalizePathLogId,
} from "./handler.js";

/** GET CBOR public root for a log. */
export async function handleGetPublicRoot(
  logIdSegment: string,
  _request: Request,
  env: Env,
): Promise<Response> {
  try {
    const logIdHex32 = normalizePathLogId(logIdSegment);
    if (logIdHex32 instanceof Response) return logIdHex32;

    return forwardToStore(env, logIdHex32, `/public-root/${logIdHex32}`, {
      method: "GET",
      headers: { Accept: "application/cbor" },
    });
  } catch (error) {
    return internalError(error);
  }
}
