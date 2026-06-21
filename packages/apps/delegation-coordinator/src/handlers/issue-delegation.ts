/**
 * Handler for POST /api/delegations — lookup stored material and return CBOR cert.
 */

import type { Env } from "../env.js";
import { decode } from "cbor-x";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import { issuerTokenForLog } from "../auth/issuer-token-for-log.js";
import { logIdWireBytesToHex32 } from "../log-id.js";
import type { DelegationIssueRequest } from "../types/delegation-issue-request.js";
import {
  getStoreStubForLogId,
  internalError,
  problemResponse,
} from "./handler.js";

const CBOR_CONTENT_TYPE = "application/cbor";

export async function handleIssueDelegation(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
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
    const body = decode(new Uint8Array(buffer)) as DelegationIssueRequest;

    if (!body.logId || !(body.logId instanceof Uint8Array)) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "logId is required",
      );
    }

    let logIdHex32: string;
    try {
      logIdHex32 = logIdWireBytesToHex32(body.logId);
    } catch (error) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        error instanceof Error ? error.message : "Invalid logId",
      );
    }

    const issuerToken = await issuerTokenForLog(env, logIdHex32);
    const authErr = checkBearerToken(
      request,
      env.COORDINATOR_APP_TOKEN,
      issuerToken,
    );
    if (authErr) return authErr;

    const stub = getStoreStubForLogId(env, logIdHex32);
    return stub.fetch("https://do.internal/issue", {
      method: "POST",
      headers: { "Content-Type": "application/cbor" },
      body: buffer,
    });
  } catch (error) {
    return internalError(error);
  }
}
