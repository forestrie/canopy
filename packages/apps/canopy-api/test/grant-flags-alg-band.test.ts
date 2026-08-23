/**
 * GF_ALG_MASK band guard (univocity ADR-0008) — canopy wire byte 2 (univocity
 * uint256 bits 40–47) is the NATIVE algorithm-policy band (first flag
 * GF_REQUIRES_USER_VERIFICATION = 1<<40). Unlike the byte-3 derived band,
 * canopy must never assign bits here: any set bit the presented delegation
 * algorithm does not consume reverts UnsupportedDelegationPolicyFlags at
 * publishCheckpoint. Canopy sets no byte-2 bit today; this pins that for the
 * canopy-api copy of grant-flags, mirroring the byte-3 guards in
 * grant-flags-child-payment.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  authLogBootstrapShapedFlags,
  derivedEndorsementGrantFlags,
  withChildPaymentRequired,
} from "../src/grant/grant-flags.js";

/** Mirror grant-commitment.ts `grantFlags32`: 8 wire bytes at offset 24 of 32, big-endian. */
function univocityFlagsUint(grant: Uint8Array): bigint {
  const out = new Uint8Array(32);
  out.set(grant.slice(-8), 24);
  let v = 0n;
  for (const b of out) v = (v << 8n) | BigInt(b);
  return v;
}

describe("GF_ALG_MASK band — wire byte 2 is univocity-native (ADR-0008)", () => {
  const constructors: Array<[string, () => Uint8Array]> = [
    ["authLogBootstrapShapedFlags", authLogBootstrapShapedFlags],
    ["derivedEndorsementGrantFlags", derivedEndorsementGrantFlags],
    [
      "withChildPaymentRequired",
      () => withChildPaymentRequired(new Uint8Array(8)),
    ],
  ];

  it.each(constructors)("%s keeps wire byte 2 clear", (_name, build) => {
    expect(build()[2]).toBe(0);
  });

  it("no constructed grant lands bits in the univocity alg band (40–47)", () => {
    for (const [, build] of constructors) {
      const v = univocityFlagsUint(build());
      expect((v >> 40n) & 0xffn).toBe(0n);
    }
  });
});
