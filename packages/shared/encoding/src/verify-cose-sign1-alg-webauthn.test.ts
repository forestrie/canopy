/**
 * ALG_ES256_WEBAUTHN (-65800, univocity ADR-0008) fail-closed guard. The
 * off-chain verifier deliberately does NOT support the WebAuthn delegation
 * algorithm (ceremony verification is deferred scope): an assertion-shaped
 * envelope can never verify as a plain COSE Sign1, so the alg must be
 * rejected as unknown rather than attempted as ES256.
 */

import { describe, expect, it } from "vitest";
import { COSE_ALG_ES256, COSE_ALG_KS256, algToCurve } from "./index.js";

const COSE_ALG_ES256_WEBAUTHN = -65800;

describe("algToCurve — ALG_ES256_WEBAUTHN is rejected fail-closed", () => {
  it("returns null for -65800 (never mapped to P-256 despite the shared curve)", () => {
    expect(algToCurve(COSE_ALG_ES256_WEBAUTHN)).toBeNull();
  });

  it("keeps the supported set unchanged: ES256 maps, KS256 and unknowns do not", () => {
    expect(algToCurve(COSE_ALG_ES256)).toBe("P-256");
    expect(algToCurve(COSE_ALG_KS256)).toBeNull();
    expect(algToCurve(0)).toBeNull();
  });
});
