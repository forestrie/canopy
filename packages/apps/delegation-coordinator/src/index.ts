/**
 * delegation-coordinator Worker
 *
 * Phase 3 management APIs for signing routes, delegation material, pending
 * hints, and custody-key orchestration (plan-0021).
 */

import type { Env } from "./env.js";
import {
  handleGetPendingDelegation,
  handleGetPending,
  handleGetPublicRoot,
  handleGetSigningRoute,
  handleIssueDelegation,
  handlePostCustodyKeys,
  handlePostMaterial,
  handlePostPublicRoot,
  handlePostSigningRoute,
} from "./handlers/index.js";

export { DelegationStoreDO } from "./durableobjects/index.js";

export default {
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

    if (pathname === "/api/delegations" && method === "POST") {
      return handleIssueDelegation(request, env);
    }

    if (pathname === "/api/delegations/material" && method === "POST") {
      return handlePostMaterial(request, env);
    }

    if (pathname === "/api/delegations/pending" && method === "GET") {
      return handleGetPending(request, env);
    }

    const pendingDelegationMatch =
      /^\/api\/logs\/([^/]+)\/pending-delegation$/.exec(pathname);
    if (pendingDelegationMatch && method === "GET") {
      const logId = decodeURIComponent(pendingDelegationMatch[1]!);
      return handleGetPendingDelegation(logId, request, env);
    }

    const signingRouteMatch = /^\/api\/logs\/([^/]+)\/signing-route$/.exec(
      pathname,
    );
    if (signingRouteMatch) {
      const logId = decodeURIComponent(signingRouteMatch[1]!);
      if (method === "GET") {
        return handleGetSigningRoute(logId, request, env);
      }
      if (method === "POST") {
        return handlePostSigningRoute(logId, request, env);
      }
    }

    const custodyKeysMatch = /^\/api\/logs\/([^/]+)\/custody-keys$/.exec(
      pathname,
    );
    if (custodyKeysMatch && method === "POST") {
      const logId = decodeURIComponent(custodyKeysMatch[1]!);
      return handlePostCustodyKeys(logId, request, env);
    }

    const publicRootMatch = /^\/api\/logs\/([^/]+)\/public-root$/.exec(
      pathname,
    );
    if (publicRootMatch) {
      const logId = decodeURIComponent(publicRootMatch[1]!);
      if (method === "GET") {
        return handleGetPublicRoot(logId, request, env);
      }
      if (method === "POST") {
        return handlePostPublicRoot(logId, request, env);
      }
    }

    if (pathname.startsWith("/api/")) {
      return new Response("Method Not Allowed", { status: 405 });
    }

    return new Response("delegation-coordinator worker", { status: 200 });
  },
};
