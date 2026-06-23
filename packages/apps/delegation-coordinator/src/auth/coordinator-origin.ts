import type { Env } from "../env.js";

/** Canonical audience/origin string for control-plane session tokens. */
export function coordinatorOrigin(env: Env, request: Request): string {
  const configured = env.COORDINATOR_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return new URL(request.url).origin;
}
