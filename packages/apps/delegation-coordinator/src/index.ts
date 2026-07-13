/**
 * delegation-coordinator Worker entry and HTTP route table.
 *
 * Phase 3 control-plane APIs for signing routes, BYOK delegation certificates,
 * pending hints, custody-key orchestration, webhooks, and wallet-challenge auth.
 * Persists per-log state in sharded {@link DelegationStoreDO}; sealer issue
 * flow per
 * [arbor sealer](https://github.com/forestrie/arbor/blob/main/services/sealer/)
 * and
 * [ARC-0017](https://github.com/forestrie/devdocs/blob/main/arc/arc-0017-hierarchical-authority-logs-and-fee-distribution.md).
 */

import type { Env } from "./env.js";
import {
  handleGetPendingDelegation,
  handleGetPending,
  handleGetPublicRoot,
  handleGetSigningRoute,
  handleIssueDelegation,
  handlePostCustodyKeys,
  handleAdminPostCustodyKeys,
  handlePostCertificate,
  handlePostDelegateKeys,
  handlePostPublicRoot,
  handlePostSigningRoute,
  handleAdminResetStorage,
  handleGetWebhook,
  handlePutWebhook,
  handleDeleteWebhook,
  handleGetEnabled,
  handlePutEnabled,
  handleAdminGetEnabled,
  handleAdminPutEnabled,
  handleGetWebhookJwks,
  handlePostAuthChallenge,
  handlePostAuthSession,
  WEBHOOK_JWKS_PATH,
} from "./handlers/index.js";

export {
  DelegationStoreDO,
  WalletChallengeNonceDO,
} from "./durableobjects/index.js";

/** Extract log id path segment from /api/logs/{logId}/{suffix}. */
function matchLogRoute(pathname: string, suffix: string): string | null {
  const match = new RegExp(`^/api/logs/([^/]+)/${suffix}$`).exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

/** Extract log id from /admin/api/logs/{logId}/{suffix}. */
function matchAdminLogRoute(pathname: string, suffix: string): string | null {
  const match = new RegExp(`^/admin/api/logs/([^/]+)/${suffix}$`).exec(
    pathname,
  );
  return match ? decodeURIComponent(match[1]!) : null;
}

/** Cloudflare Worker default export — HTTP fetch router. */
export default {
  /**
   * Route incoming requests to handlers or Durable Object exports.
   *
   * @param request - Incoming HTTP request.
   * @param env - Worker bindings.
   * @param _ctx - Execution context (unused).
   */
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;

    if (pathname === "/_delegation-coordinator/health" && method === "GET") {
      return Response.json({
        status: "ok",
        nodeEnv: env.NODE_ENV,
      });
    }

    if (pathname === WEBHOOK_JWKS_PATH && method === "GET") {
      return handleGetWebhookJwks(env);
    }

    if (pathname === "/admin/reset-storage" && method === "POST") {
      return handleAdminResetStorage(request, url, env);
    }

    if (pathname === "/api/auth/challenge" && method === "POST") {
      return handlePostAuthChallenge(request, env);
    }

    if (pathname === "/api/auth/session" && method === "POST") {
      return handlePostAuthSession(request, env);
    }

    if (pathname === "/api/delegations" && method === "POST") {
      return handleIssueDelegation(request, env);
    }

    if (pathname === "/api/delegations/certificate" && method === "POST") {
      return handlePostCertificate(request, env);
    }

    if (pathname === "/api/sealer/delegate-keys" && method === "POST") {
      return handlePostDelegateKeys(request, env);
    }

    if (pathname === "/api/delegations/pending" && method === "GET") {
      return handleGetPending(request, env);
    }

    const pendingDelegationLogId = matchLogRoute(
      pathname,
      "pending-delegation",
    );
    if (pendingDelegationLogId && method === "GET") {
      return handleGetPendingDelegation(pendingDelegationLogId, request, env);
    }

    const signingRouteLogId = matchLogRoute(pathname, "signing-route");
    if (signingRouteLogId) {
      if (method === "GET") {
        return handleGetSigningRoute(signingRouteLogId, request, env);
      }
      if (method === "POST") {
        return handlePostSigningRoute(signingRouteLogId, request, env);
      }
    }

    const custodyKeysLogId = matchLogRoute(pathname, "custody-keys");
    if (custodyKeysLogId && method === "POST") {
      return handlePostCustodyKeys(custodyKeysLogId, request, env);
    }

    const adminCustodyKeysLogId = matchAdminLogRoute(pathname, "custody-keys");
    if (adminCustodyKeysLogId && method === "POST") {
      return handleAdminPostCustodyKeys(adminCustodyKeysLogId, request, env);
    }

    const publicRootLogId = matchLogRoute(pathname, "public-root");
    if (publicRootLogId) {
      if (method === "GET") {
        return handleGetPublicRoot(publicRootLogId, request, env);
      }
      if (method === "POST") {
        return handlePostPublicRoot(publicRootLogId, request, env);
      }
    }

    const webhookLogId = matchLogRoute(pathname, "webhook");
    if (webhookLogId) {
      if (method === "GET") {
        return handleGetWebhook(webhookLogId, request, env);
      }
      if (method === "PUT") {
        return handlePutWebhook(webhookLogId, request, env);
      }
      if (method === "DELETE") {
        return handleDeleteWebhook(webhookLogId, request, env);
      }
    }

    const enabledLogId = matchLogRoute(pathname, "enabled");
    if (enabledLogId) {
      if (method === "GET") {
        return handleGetEnabled(enabledLogId, request, env);
      }
      if (method === "PUT") {
        return handlePutEnabled(enabledLogId, request, env);
      }
    }

    const adminEnabledLogId = matchAdminLogRoute(pathname, "enabled");
    if (adminEnabledLogId) {
      if (method === "GET") {
        return handleAdminGetEnabled(adminEnabledLogId, request, env);
      }
      if (method === "PUT") {
        return handleAdminPutEnabled(adminEnabledLogId, request, env);
      }
    }

    if (pathname.startsWith("/api/") || pathname.startsWith("/admin/api/")) {
      return new Response("Method Not Allowed", { status: 405 });
    }

    return new Response("delegation-coordinator worker", { status: 200 });
  },
};
