/**
 * Canonical coordinator origin for wallet-challenge session audience.
 *
 * Used as `aud` when minting and verifying control-plane session tokens.
 */

import type { Env } from "../env.js";

/**
 * Resolve audience/origin string for control-plane session tokens.
 *
 * Prefers {@link Env.COORDINATOR_PUBLIC_URL} over the request origin.
 *
 * @param env - Worker bindings.
 * @param request - Incoming request (fallback origin source).
 * @returns Origin URL without trailing slash.
 */
export function coordinatorOrigin(env: Env, request: Request): string {
  const configured = env.COORDINATOR_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return new URL(request.url).origin;
}
