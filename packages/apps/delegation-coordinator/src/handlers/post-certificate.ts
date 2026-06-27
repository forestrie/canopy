/**
 * POST /api/delegations/certificate — runner BYOK certificate submission.
 *
 * Public route with size cap; validated in {@link DelegationStoreDO} via
 * {@link validateByokDelegationCertificate}.
 */

import type { Env } from "../env.js";
import { base64ToBytes } from "../encoding.js";
import { normalizeLogIdToHex32 } from "../log-id.js";
import type { SubmitDelegationCertificateRequest } from "../types/submit-delegation-certificate-request.js";
import { forwardToStore, internalError, problemResponse } from "./handler.js";

/** Max decoded certificate bytes accepted on the public sealing route. */
export const MAX_CERTIFICATE_BYTES = 16 * 1024;

/** POST certificate JSON to sharded store after size checks. */
export async function handlePostCertificate(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const contentLength = request.headers.get("Content-Length");
    if (contentLength !== null) {
      const len = Number.parseInt(contentLength, 10);
      if (Number.isFinite(len) && len > MAX_CERTIFICATE_BYTES * 4) {
        return problemResponse(
          413,
          "about:blank",
          "Payload Too Large",
          `request body must not exceed ${MAX_CERTIFICATE_BYTES} bytes of certificate data`,
        );
      }
    }

    const body = (await request.json()) as SubmitDelegationCertificateRequest;
    if (
      !body.logId ||
      body.mmrStart === undefined ||
      body.mmrEnd === undefined ||
      !body.delegatedPublicKey ||
      !body.certificate
    ) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "logId, mmrStart, mmrEnd, delegatedPublicKey, and certificate are required",
      );
    }

    let certificateBytes: Uint8Array;
    try {
      certificateBytes = base64ToBytes(body.certificate);
    } catch {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "certificate must be valid base64",
      );
    }
    if (certificateBytes.length > MAX_CERTIFICATE_BYTES) {
      return problemResponse(
        413,
        "about:blank",
        "Payload Too Large",
        `certificate must not exceed ${MAX_CERTIFICATE_BYTES} bytes`,
      );
    }

    let logIdHex32: string;
    try {
      logIdHex32 = normalizeLogIdToHex32(body.logId);
    } catch (error) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        error instanceof Error ? error.message : "Invalid logId",
      );
    }

    const payload: SubmitDelegationCertificateRequest = {
      ...body,
      logId: logIdHex32,
    };

    return forwardToStore(env, logIdHex32, "/certificate", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return internalError(error);
  }
}
