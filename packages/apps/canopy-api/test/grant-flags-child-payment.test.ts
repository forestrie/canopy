/**
 * GF_CHILD_PAYMENT_REQUIRED parent-grant policy bit (plan-2608-09, adr-0062) —
 * guards the canopy-api copy of grant-flags against drifting from the
 * @forestrie/grant-builder canonical copy. The bit rides canopy wire byte 3
 * mask 0x08 and lands on univocity uint256 bit 35; it is only honoured
 * alongside GF_DERIVED (byte 3 mask 0x04, bit 34).
 */

import { describe, expect, it } from "vitest";
import {
  hasChildPaymentRequiredFlag,
  hasDerivedFlag,
  requiresChildPayment,
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

describe("canopy-api grant-flags — GF_CHILD_PAYMENT_REQUIRED", () => {
  it("withChildPaymentRequired sets byte 3 = 0x0c and round-trips the predicates", () => {
    const flags = withChildPaymentRequired(new Uint8Array(8));
    expect(flags[3]).toBe(0x0c);
    expect(hasDerivedFlag(flags)).toBe(true);
    expect(hasChildPaymentRequiredFlag(flags)).toBe(true);
    expect(requiresChildPayment(flags)).toBe(true);
  });

  it("requiresChildPayment needs GF_DERIVED — bare payment bit carries no policy", () => {
    const bare = new Uint8Array(8);
    bare[3] = 0x08;
    expect(hasChildPaymentRequiredFlag(bare)).toBe(true);
    expect(requiresChildPayment(bare)).toBe(false);
  });

  it("lands on univocity bit 35 alongside GF_DERIVED (bit 34)", () => {
    const v = univocityFlagsUint(withChildPaymentRequired(new Uint8Array(8)));
    expect(v).toBe(0xc00000000n); // exactly bits 34 and 35
  });
});
