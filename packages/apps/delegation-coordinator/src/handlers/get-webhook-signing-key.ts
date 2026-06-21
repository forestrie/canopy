/**
 * Handler for GET /api/coordinator/webhook-signing-key (public).
 */

import type { Env } from "../env.js";
import { getWebhookSigningKeyInfo } from "../webhook/signing-key.js";
import { internalError } from "./handler.js";

export async function handleGetWebhookSigningKey(env: Env): Promise<Response> {
  try {
    const info = await getWebhookSigningKeyInfo(env);
    return Response.json(info);
  } catch (error) {
    return internalError(error);
  }
}
