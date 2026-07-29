/**
 * Account-read attestation (FOR-497): the ADR-0059 D8 bootstrap-key pattern
 * reused as a read credential for the owner-facing fee-account read.
 *
 * Same envelope as the onboard attestation — COSE_Sign1 over a CWT binding
 * the chain binding, a freshness window, and the operator origin, signed by
 * the chain-declared `bootstrapConfig()` key — under its OWN signed content
 * type. A captured onboarding attestation must never replay as a read
 * credential and vice versa (the slice-06 cross-protocol discipline);
 * `verifyBootstrapKeyCwt` enforces that by content-type discrimination.
 *
 * The freshness ceiling is minutes, not onboarding's hours: the read is
 * interactive, and the key is at hand when the request is made.
 */

import type { Ks256VerifyHooks } from "@forestrie/delegation-cose";
import {
  verifyBootstrapKeyCwt,
  type BootstrapKeyCwtExpectation,
  type BootstrapKeyCwtResult,
} from "../onboarding/onboard-attestation.js";

/** Signed content type — the domain separator for the read envelope. */
export const ACCOUNT_READ_ATTESTATION_CONTENT_TYPE =
  "application/forestrie-account-read+cwt";

/** Default ceiling on `exp - iat` — the read is interactive (≤ 5 min). */
export const DEFAULT_ACCOUNT_READ_MAX_WINDOW_SEC = 300;

/**
 * Verify an account-read attestation against chain-derived expectations.
 * Applies the read-domain window ceiling unless the caller overrides it.
 */
export function verifyAccountReadAttestation(
  attestation: Uint8Array,
  expected: BootstrapKeyCwtExpectation,
  hooks?: Ks256VerifyHooks,
): Promise<BootstrapKeyCwtResult> {
  return verifyBootstrapKeyCwt(
    attestation,
    {
      maxWindowSec: DEFAULT_ACCOUNT_READ_MAX_WINDOW_SEC,
      ...expected,
    },
    ACCOUNT_READ_ATTESTATION_CONTENT_TYPE,
    hooks,
  );
}
