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

/**
 * Never let a trust-root answer be cached (FOR-302, ADR-0057).
 *
 * A 404 here means "this log's root key is not visible to me", which is not the
 * same as "this log has no root key" — a BYOK root registered moments ago is
 * indistinguishable from one that was never registered. Callers turn a 404 into
 * a terminal 403, so caching it would freeze a transient answer and widen a
 * narrow propagation window into a durable rejection of valid receipts.
 *
 * The 200 is not cached either. A log's root key is immutable in principle, but
 * this response is small and read rarely enough that the correctness risk of a
 * stale positive across a re-registration is not worth the saving.
 */
const NO_STORE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
};

/** GET CBOR public root for a log. */
export async function handleGetPublicRoot(
  logIdSegment: string,
  _request: Request,
  env: Env,
): Promise<Response> {
  try {
    const logIdHex32 = normalizePathLogId(logIdSegment);
    if (logIdHex32 instanceof Response) return logIdHex32;

    const stored = await forwardToStore(
      env,
      logIdHex32,
      `/public-root/${logIdHex32}`,
      {
        method: "GET",
        headers: { Accept: "application/cbor" },
      },
    );

    // Rebuild the response rather than mutating the stub's: buffer the body
    // (a small CBOR trust root, or a problem document) and carry only the
    // content type across. Copying the Durable Object's full header set brings
    // transport headers such as Content-Length/Content-Encoding with it, which
    // no longer describe the re-framed body and make the construction throw —
    // turning a 404 into a 500.
    const body = await stored.arrayBuffer();
    const headers = new Headers(NO_STORE_HEADERS);
    const contentType = stored.headers.get("Content-Type");
    if (contentType) headers.set("Content-Type", contentType);
    return new Response(body, { status: stored.status, headers });
  } catch (error) {
    return internalError(error);
  }
}
