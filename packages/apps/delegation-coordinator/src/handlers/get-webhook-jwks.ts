/**
 * Handler for GET /.well-known/forestrie-webhook-jwks.json (public JWKS).
 */

import type { Env } from "../env.js";
import { getWebhookSigningKeyInfo } from "../webhook/signing-key.js";
import { internalError } from "./handler.js";

export const WEBHOOK_JWKS_PATH = "/.well-known/forestrie-webhook-jwks.json";

export async function handleGetWebhookJwks(env: Env): Promise<Response> {
  try {
    const info = await getWebhookSigningKeyInfo(env);
    return Response.json({
      keys: [
        {
          ...info.publicKeyJwk,
          kid: info.kid,
          use: "sig",
          alg: info.alg,
        },
      ],
    });
  } catch (error) {
    return internalError(error);
  }
}
