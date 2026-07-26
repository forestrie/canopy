/**
 * Genesis POST authorization: the onboard bearer token, and nothing else.
 *
 * The endorsement (`GF_DERIVED` grant) genesis mode is retired (ADR-0059,
 * plan-2607-43 slice 02): every univocity instance root is its own fee
 * account, admitted via the onboarding flow — sponsorship is a payment-side
 * arrangement, not an authorization-graph edge. The `GF_DERIVED` wire flag
 * and the data-plane append path for derived leaves are unaffected.
 */

import { ClientErrors } from "../cbor-api/problem-details.js";
import { logIdSegmentToCanonicalUuid } from "../grant/log-id-wire.js";
import {
  isOnboardTokenActive,
  readOnboardTokenRecord,
} from "./onboard-token-store.js";

const FORESTRIE_GRANT_SCHEME = "Forestrie-Grant";

import type { GenesisAuthContext } from "./genesis-auth-context.js";
import type { GenesisAuthEnv } from "./genesis-auth-env.js";

export type { GenesisAuthContext, GenesisAuthEnv } from "./types.js";

function readBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization")?.trim() ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  const token = m[1]!.trim();
  return token || null;
}

function isForestrieGrantAuth(request: Request): boolean {
  const auth = request.headers.get("Authorization")?.trim() ?? "";
  return auth.startsWith(`${FORESTRIE_GRANT_SCHEME} `);
}

/**
 * Resolve genesis POST auth: onboard bearer token only.
 */
export async function resolveGenesisAuth(
  request: Request,
  logIdRouteSegment: string,
  env: GenesisAuthEnv,
): Promise<GenesisAuthContext | Response> {
  if (isForestrieGrantAuth(request)) {
    return ClientErrors.forbidden(
      "Endorsement-grant genesis is retired (ADR-0059): every univocity instance is its own account. Obtain an onboard token via POST /api/onboarding/requests and redeem it.",
    );
  }

  const bearer = readBearerToken(request);
  if (!bearer) {
    return ClientErrors.unauthorized(
      "Authorization required: Bearer <CANOPY_PAYMENTS_ONBOARD_TOKEN>.",
    );
  }

  const active = await isOnboardTokenActive(env, bearer);
  if (!active.active) {
    return ClientErrors.unauthorized("Invalid or revoked onboard token.");
  }

  const tokenRecord = await readOnboardTokenRecord(env, active.hash);
  if (!tokenRecord) {
    return ClientErrors.unauthorized("Invalid or revoked onboard token.");
  }
  if (tokenRecord.consumedForestR) {
    let pathUuid: string;
    try {
      pathUuid = logIdSegmentToCanonicalUuid(logIdRouteSegment);
    } catch {
      return ClientErrors.badRequest("Invalid log-id in path");
    }
    if (tokenRecord.consumedForestR !== pathUuid) {
      return ClientErrors.forbidden(
        "Onboard token already consumed for a different forest.",
      );
    }
  }

  return { mode: "onboard", tokenHash: active.hash, tokenRecord };
}
