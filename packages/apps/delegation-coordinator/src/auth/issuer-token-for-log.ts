/**
 * Load per-log issuerToken from signing_routes for dual-token auth.
 *
 * Used by POST /api/delegations alongside {@link Env.COORDINATOR_APP_TOKEN}
 * per [ARC-0017](https://github.com/forestrie/devdocs/blob/main/arc/arc-0017-hierarchical-authority-logs-and-fee-distribution.md).
 */

import type { Env } from "../env.js";
import { forwardToStore } from "../handlers/handler.js";

/**
 * Fetch optional issuerToken configured on the log signing route.
 *
 * @param env - Worker bindings.
 * @param logIdHex32 - Target log id.
 * @returns Trimmed issuer token or undefined when route missing / unset.
 */
export async function issuerTokenForLog(
  env: Env,
  logIdHex32: string,
): Promise<string | undefined> {
  const routeResp = await forwardToStore(
    env,
    logIdHex32,
    `/signing-route/${logIdHex32}`,
    { method: "GET" },
  );
  if (!routeResp.ok) return undefined;
  const route = (await routeResp.json()) as { issuerToken?: string };
  return route.issuerToken?.trim() || undefined;
}
