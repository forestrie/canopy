import type { ReceiptAuthorityResolver } from "../env/receipt-authority-resolver.js";
import { bytesEqual } from "../cbor-api/cbor-map-utils.js";
import { ClientErrors } from "../cbor-api/problem-details.js";
import { hasDerivedFlag } from "../grant/grant-flags.js";
import { logIdToWireBytes } from "../grant/log-id-wire.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import type { GrantResult } from "../grant/types.js";
import {
  getGrantFromRequest,
  grantAuthorize,
  type AuthGrantAuthorizeEnv,
} from "../scrapi/auth-grant.js";
import { isCanopyApiPoolTestMode } from "../env/runtime-mode.js";
import {
  isOnboardTokenActive,
  type OnboardTokenStoreEnv,
} from "./onboard-token-store.js";
import { resolvePaymentAncestor } from "./resolve-payment-ancestor.js";
import type { RegistrationStoreEnv } from "./registration-store.js";

const FORESTRIE_GRANT_SCHEME = "Forestrie-Grant";

export type GenesisAuthContext =
  | { mode: "onboard"; tokenHash: string }
  | { mode: "endorsement"; endorserUuid: string; grantResult: GrantResult };

export interface GenesisAuthEnv
  extends OnboardTokenStoreEnv,
    RegistrationStoreEnv {
  NODE_ENV: string;
  resolveReceiptAuthority?: ReceiptAuthorityResolver;
}

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

function grantAuthorizeEnv(env: GenesisAuthEnv): AuthGrantAuthorizeEnv {
  return {
    enforceInclusion: !isCanopyApiPoolTestMode(env),
    resolveReceiptAuthority: env.resolveReceiptAuthority,
  };
}

/**
 * Resolve genesis POST auth: onboard bearer token or completed endorsement grant.
 */
export async function resolveGenesisAuth(
  request: Request,
  logIdRouteSegment: string,
  env: GenesisAuthEnv,
): Promise<GenesisAuthContext | Response> {
  if (isForestrieGrantAuth(request)) {
    const grantParsed = getGrantFromRequest(request);
    if (grantParsed instanceof Response) return grantParsed;

    if (!hasDerivedFlag(grantParsed.grant.grant)) {
      return ClientErrors.forbidden(
        "Genesis endorsement grant must carry GF_DERIVED.",
      );
    }

    let pathWire: Uint8Array;
    try {
      pathWire = logIdToWireBytes(logIdRouteSegment);
    } catch {
      return ClientErrors.badRequest("Invalid log-id in path");
    }

    if (!bytesEqual(grantParsed.grant.logId, pathWire)) {
      return ClientErrors.forbidden(
        "Endorsement grant logId must match path forest root R'.",
      );
    }

    const authErr = await grantAuthorize(grantParsed, grantAuthorizeEnv(env));
    if (authErr) return authErr;

    const endorserUuid = bytesToUuid(grantParsed.grant.ownerLogId);
    const ancestor = await resolvePaymentAncestor(env, endorserUuid);
    if (!ancestor.ok) {
      return ClientErrors.forbidden(
        "Endorsement grant is not rooted in a payment-authoritative registration.",
      );
    }

    return {
      mode: "endorsement",
      endorserUuid,
      grantResult: grantParsed,
    };
  }

  const bearer = readBearerToken(request);
  if (!bearer) {
    return ClientErrors.unauthorized(
      "Authorization required: Bearer <CANOPY_PAYMENTS_ONBOARD_TOKEN> or Forestrie-Grant <completed endorsement grant>.",
    );
  }

  const active = await isOnboardTokenActive(env, bearer);
  if (!active.active) {
    return ClientErrors.unauthorized("Invalid or revoked onboard token.");
  }

  return { mode: "onboard", tokenHash: active.hash };
}
