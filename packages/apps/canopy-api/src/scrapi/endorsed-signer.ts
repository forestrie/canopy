/**
 * Register-statement signer resolution under an endorsed session key
 * (devdocs ADR-0065 §4, plan-2608-14 2.1).
 *
 * canopy SCRAPI admission is THE leaf-signer enforcement point (ADR-0065
 * §1). `register-signed-statement` derives the pair (kid binding, signature
 * verify key) from exactly ONE source:
 *
 * 1. **No `-65801` entry** on the statement: `grantData`, exactly as before
 *    — kid == `grantData[0:32]` (or the 16-byte custodian kid for KMS-signed
 *    bootstrap statements), signature under the `grantData` key.
 * 2. **`-65801` present**: the entry MUST verify as an ADR-0065 §3 v2
 *    session-key endorsement under the **`grantData` root** (the trust anchor
 *    is the coordinate pair from `grantData`, so `kid == root x` is pinned),
 *    with `requireUserVerification` iff the grant carries
 *    `GF_REQUIRES_USER_VERIFICATION`, and its window must contain canopy's
 *    clock. The binding then becomes the endorsed session key's x and the
 *    statement is verified under the endorsed session key.
 *
 * A present-but-invalid endorsement is a 403 with a distinct reason and
 * admission NEVER falls back to the `grantData` binding; the custodian
 * 16-byte branch is not consulted when an endorsement is present. The
 * window check is a pure function of the endorsement and the clock, run on
 * every request — structurally outside any cache (none exists yet; see
 * plan-2608-14 2.2 for the optional bounded "verified OK" cache).
 *
 * The verification primitive is `@forestrie/receipt-verify`'s
 * `verifySessionKeyEndorsement` — the same code an offline auditor runs in
 * `verifyEndorsedLeaf` (ADR-0065 §5: one verification path).
 */

import {
  checkEndorsementWindow,
  endorsementAdmissionReason,
  extractLeafEndorsement,
  verifySessionKeyEndorsement,
} from "@forestrie/receipt-verify";
import { grantDataToBytes } from "../grant/grant-data.js";
import { hasRequiresUserVerification } from "../grant/grant-flags.js";
import type { Grant } from "../grant/types.js";
import { GrantAuthErrors } from "./grant-auth.js";

/**
 * Tolerance for an endorsement whose `notBefore` is slightly ahead of
 * canopy's clock (a browser clock a little fast). Small on purpose: the
 * offline check against the receipted idtimestamp is the authoritative one
 * (ADR-0065 §Accepted risks: Clock).
 */
export const ENDORSEMENT_NOT_BEFORE_SKEW_MS = 5 * 60 * 1000;

/** Outcome of {@link resolveEndorsedStatementSigner}. */
export type StatementSignerResolution =
  /** No -65801 entry: bind and verify against `grantData` as today. */
  | { kind: "grant-data" }
  /** Endorsement verified: bind kid to `sessionPublicKeyXY[0:32]`, verify under `sessionKey`. */
  | {
      kind: "endorsed";
      sessionPublicKeyXY: Uint8Array;
      sessionKey: CryptoKey;
      notBefore: number;
      notAfter: number;
    }
  /** Endorsement present but not admissible — the 403 to return; never fall back. */
  | { kind: "rejected"; reason: string; response: Response };

function logEndorsement(event: string, extra: Record<string, unknown>): void {
  console.warn(JSON.stringify({ tag: "endorsed-signer", event, ...extra }));
}

/**
 * Resolve the statement-signer source for `statementData` under `grant`.
 *
 * @param statementData - The statement COSE Sign1 bytes (structure already validated)
 * @param grant - The authorising Forestrie-Grant (already authorised by inclusion)
 * @param opts.nowMs - canopy's clock, unix ms (injected for tests)
 */
export async function resolveEndorsedStatementSigner(
  statementData: Uint8Array,
  grant: Grant,
  opts: { nowMs: number; skewMs?: number },
): Promise<StatementSignerResolution> {
  const extracted = extractLeafEndorsement(statementData);
  if (extracted.kind === "missing") return { kind: "grant-data" };
  if (extracted.kind === "invalid") {
    logEndorsement("endorsement_invalid", { detail: "entry is not a bstr" });
    return {
      kind: "rejected",
      reason: "endorsement_invalid",
      response: GrantAuthErrors.endorsementInvalid(
        "Session-key endorsement (-65801) is not a COSE Sign1 byte string.",
      ),
    };
  }

  // The trust anchor is the coordinate pair FROM grantData. Anything that
  // is not an ES256 x||y root cannot have endorsed a session key.
  const grantDataBytes = grantDataToBytes(grant.grantData);
  if (grantDataBytes.length !== 64) {
    logEndorsement("endorsement_root_mismatch", {
      grantDataLen: grantDataBytes.length,
    });
    return {
      kind: "rejected",
      reason: "endorsement_root_mismatch",
      response: GrantAuthErrors.endorsementRootMismatch(
        "Session-key endorsement presented, but the grant's grantData is not an ES256 x||y root.",
      ),
    };
  }

  const requireUserVerification = hasRequiresUserVerification(
    grant.grant as Uint8Array,
  );
  const verified = await verifySessionKeyEndorsement(
    extracted.endorsement,
    {
      x: grantDataBytes.subarray(0, 32),
      y: grantDataBytes.subarray(32, 64),
      curve: "P-256",
    },
    {
      requireUserVerification,
      logFailures: true,
      logPrefix: "register-statement-endorsement",
    },
  );
  if (!verified.ok) {
    // ADR-0065 §4 vocabulary (a malformed window folds to expired: no
    // instant is inside it).
    const reason = endorsementAdmissionReason(verified.reason);
    logEndorsement(reason, {
      verifierReason: verified.reason,
      requireUserVerification,
    });
    switch (reason) {
      case "endorsement_root_mismatch":
        return {
          kind: "rejected",
          reason,
          response: GrantAuthErrors.endorsementRootMismatch(),
        };
      case "endorsement_uv_required":
        return {
          kind: "rejected",
          reason,
          response: GrantAuthErrors.endorsementUvRequired(),
        };
      case "endorsement_expired":
        return {
          kind: "rejected",
          reason,
          response: GrantAuthErrors.endorsementExpired(
            "Session-key endorsement window is malformed (notAfter <= notBefore).",
          ),
        };
      default:
        return {
          kind: "rejected",
          reason: "endorsement_invalid",
          response: GrantAuthErrors.endorsementInvalid(
            `Session-key endorsement did not verify (${verified.reason}).`,
          ),
        };
    }
  }

  // The window, against canopy's clock, on every request.
  const window = checkEndorsementWindow(verified, opts.nowMs, {
    skewMs: opts.skewMs ?? ENDORSEMENT_NOT_BEFORE_SKEW_MS,
  });
  if (!window.ok) {
    logEndorsement("endorsement_expired", {
      direction: window.reason,
      notBefore: verified.notBefore,
      notAfter: verified.notAfter,
      nowMs: opts.nowMs,
    });
    return {
      kind: "rejected",
      reason: "endorsement_expired",
      response: GrantAuthErrors.endorsementExpired(
        window.reason === "endorsement_not_yet_valid"
          ? "Session-key endorsement is not yet valid (notBefore is in the future)."
          : "Session-key endorsement has expired (notAfter is in the past).",
      ),
    };
  }

  return {
    kind: "endorsed",
    sessionPublicKeyXY: verified.sessionPublicKeyXY,
    sessionKey: verified.sessionKey,
    notBefore: verified.notBefore,
    notAfter: verified.notAfter,
  };
}
