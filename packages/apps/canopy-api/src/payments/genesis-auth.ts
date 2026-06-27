import type { ReceiptAuthorityResolver } from "../env/receipt-authority-resolver.js";
import { bytesEqual } from "../cbor-api/cbor-map-utils.js";
import { ClientErrors } from "../cbor-api/problem-details.js";
import { hasDerivedFlag } from "../grant/grant-flags.js";
import {
  logIdSegmentToCanonicalUuid,
  logIdToWireBytes,
} from "../grant/log-id-wire.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import type { GrantResult } from "../grant/types.js";
import { getGrantFromRequest, grantAuthorize } from "../scrapi/auth-grant.js";
import type { AuthGrantAuthorizeEnv } from "../scrapi/auth-grant-authorize-env.js";
import { isCanopyApiPoolTestMode } from "../env/runtime-mode.js";
import {
  isOnboardTokenActive,
  readOnboardTokenRecord,
} from "./onboard-token-store.js";
import { resolvePaymentAncestor } from "./resolve-payment-ancestor.js";
import type { RegistrationStoreEnv } from "./registration-store.js";

const FORESTRIE_GRANT_SCHEME = "Forestrie-Grant";

import type { OnboardTokenRecord } from "./onboard-token-record.js";
import { getParsedGenesis } from "../forest/genesis-cache.js";
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

function grantAuthorizeEnv(
  env: GenesisAuthEnv,
  ks256ChainId?: string,
): AuthGrantAuthorizeEnv {
  return {
    enforceInclusion: !isCanopyApiPoolTestMode(env),
    resolveReceiptAuthority: env.resolveReceiptAuthority,
    ks256ChainId,
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

    const endorserUuid = bytesToUuid(grantParsed.grant.ownerLogId);
    const endorserGenesis = await getParsedGenesis(endorserUuid, {
      R2_GRANTS: env.R2_GRANTS,
    });
    const ks256ChainId =
      "kind" in endorserGenesis
        ? undefined
        : endorserGenesis.chainBinding?.chainId;

    const authErr = await grantAuthorize(
      grantParsed,
      grantAuthorizeEnv(env, ks256ChainId),
    );
    if (authErr) return authErr;

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
        "Onboard token already consumed for a payment-authoritative forest.",
      );
    }
  }

  return { mode: "onboard", tokenHash: active.hash, tokenRecord };
}
