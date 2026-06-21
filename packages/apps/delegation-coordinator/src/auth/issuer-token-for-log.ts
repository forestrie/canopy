/**
 * Load per-log issuerToken from signing_routes (for dual-token auth).
 */

import type { Env } from "../env.js";
import { forwardToStore } from "../handlers/handler.js";

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
