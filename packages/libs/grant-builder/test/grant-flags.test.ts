import { describe, expect, it } from "vitest";
import {
  authLogBootstrapShapedFlags,
  dataLogCreateExtendFlags,
  dataLogExtendFlags,
  derivedEndorsementGrantFlags,
  hasChildPaymentRequiredFlag,
  hasCreateAndExtend,
  hasDataLogClass,
  hasDerivedFlag,
  hasExtendCapability,
  hasRequiresUserVerification,
  isDataLogStatementGrantFlags,
  requiresChildPayment,
  withChildPaymentRequired,
  withRequiresUserVerification,
} from "../src/index.js";

/**
 * Mirror grant-commitment.ts `grantFlags32`: place the 8 wire bytes into the low
 * 8 bytes (offset 24) of a 32-byte buffer, then read it as a big-endian uint256.
 * This is the exact placement the univocity contract sees, so asserting on the
 * returned bits proves canopy wire byte 3 lands on univocity bits 32–39.
 */
function univocityFlagsUint(grant: Uint8Array): bigint {
  const out = new Uint8Array(32);
  out.set(grant.slice(-8), 24);
  let v = 0n;
  for (const b of out) v = (v << 8n) | BigInt(b);
  return v;
}

describe("dataLogExtendFlags — extend-only writer grant (ADR-0052)", () => {
  it("sets GF_EXTEND (byte 3 = 0x02) and GF_DATA_LOG (byte 7 = 0x02), NOT GF_CREATE", () => {
    const flags = dataLogExtendFlags();
    expect(flags.length).toBe(8);
    expect(flags[3]).toBe(0x02);
    expect(flags[7]).toBe(0x02);
  });

  it("has extend capability and data-log class but NOT create+extend", () => {
    const flags = dataLogExtendFlags();
    expect(hasExtendCapability(flags)).toBe(true);
    expect(hasDataLogClass(flags)).toBe(true);
    expect(hasCreateAndExtend(flags)).toBe(false);
  });

  it("is accepted as a data-log statement-registration grant (writer path)", () => {
    expect(isDataLogStatementGrantFlags(dataLogExtendFlags())).toBe(true);
  });

  it("differs from dataLogCreateExtendFlags only by the GF_CREATE bit", () => {
    const create = dataLogCreateExtendFlags();
    const extend = dataLogExtendFlags();
    expect(hasCreateAndExtend(create)).toBe(true);
    expect(hasCreateAndExtend(extend)).toBe(false);
    expect(create[7]).toBe(extend[7]); // same class (GF_DATA_LOG)
    expect(create[3] & 0x02).toBe(extend[3] & 0x02); // both carry GF_EXTEND
  });
});

describe("GF_CHILD_PAYMENT_REQUIRED — parent-grant payment policy (plan-2608-09)", () => {
  it("withChildPaymentRequired sets GF_DERIVED | GF_CHILD_PAYMENT_REQUIRED (byte 3 = 0x0c)", () => {
    const flags = withChildPaymentRequired(new Uint8Array(8));
    expect(flags.length).toBe(8);
    expect(flags[3]).toBe(0x0c); // 0x04 (GF_DERIVED) | 0x08 (GF_CHILD_PAYMENT_REQUIRED)
  });

  it("round-trips through the predicates", () => {
    const flags = withChildPaymentRequired(new Uint8Array(8));
    expect(hasDerivedFlag(flags)).toBe(true);
    expect(hasChildPaymentRequiredFlag(flags)).toBe(true);
    expect(requiresChildPayment(flags)).toBe(true);
  });

  it("preserves other flag bytes (e.g. an existing GF_AUTH_LOG parent)", () => {
    const parent = new Uint8Array(8);
    parent[3] = 0x02; // GF_EXTEND
    parent[7] = 0x01; // GF_AUTH_LOG
    const flags = withChildPaymentRequired(parent);
    expect(flags[3]).toBe(0x0e); // 0x02 | 0x04 | 0x08
    expect(flags[7]).toBe(0x01); // untouched
    expect(hasExtendCapability(flags)).toBe(true);
    expect(requiresChildPayment(flags)).toBe(true);
    // input is not mutated
    expect(parent[3]).toBe(0x02);
  });

  it("requiresChildPayment is false without GF_DERIVED (bare bit carries no policy)", () => {
    const bare = new Uint8Array(8);
    bare[3] = 0x08; // GF_CHILD_PAYMENT_REQUIRED alone
    expect(hasChildPaymentRequiredFlag(bare)).toBe(true);
    expect(hasDerivedFlag(bare)).toBe(false);
    expect(requiresChildPayment(bare)).toBe(false);
  });

  it("requiresChildPayment is false with GF_DERIVED but no payment bit", () => {
    const derivedOnly = new Uint8Array(8);
    derivedOnly[3] = 0x04; // GF_DERIVED alone
    expect(requiresChildPayment(derivedOnly)).toBe(false);
  });

  it("predicates reject short (<8 byte) grants", () => {
    expect(hasChildPaymentRequiredFlag(new Uint8Array([0, 0, 0, 0x08]))).toBe(
      false,
    );
    expect(requiresChildPayment(new Uint8Array([0, 0, 0, 0x0c]))).toBe(false);
  });

  it("lands on univocity bit 35 (byte 3 → big-endian uint256 bits 32–39)", () => {
    const flags = withChildPaymentRequired(new Uint8Array(8));
    const v = univocityFlagsUint(flags);
    expect((v >> 34n) & 1n).toBe(1n); // GF_DERIVED  = 1<<34
    expect((v >> 35n) & 1n).toBe(1n); // GF_CHILD_PAYMENT_REQUIRED = 1<<35
    // and nothing below the derived band (GF_CREATE/GF_EXTEND) set
    expect((v >> 32n) & 1n).toBe(0n);
    expect((v >> 33n) & 1n).toBe(0n);
    // exactly bits 34 and 35 → 0xc00000000
    expect(v).toBe(0xc00000000n);
  });
});

describe("GF_ALG_MASK band — wire byte 2 is univocity-native (ADR-0008)", () => {
  // Univocity v0.2.0 reserves bits 40–47 (canopy wire byte 2) as the native
  // algorithm-policy band (`GF_ALG_MASK`; first flag
  // GF_REQUIRES_USER_VERIFICATION = 1<<40). Unlike the byte-3 derived band,
  // canopy never *derives* bits here: a band bit is set only by an explicit
  // opt-in constructor (`withRequiresUserVerification`), because any set bit
  // the presented delegation algorithm does not consume reverts
  // UnsupportedDelegationPolicyFlags at publishCheckpoint. Every other
  // constructor keeps byte 2 clear — this pins the clear-by-default premise.
  const constructors: Array<[string, () => Uint8Array]> = [
    ["authLogBootstrapShapedFlags", authLogBootstrapShapedFlags],
    ["dataLogCreateExtendFlags", dataLogCreateExtendFlags],
    ["dataLogExtendFlags", dataLogExtendFlags],
    ["derivedEndorsementGrantFlags", derivedEndorsementGrantFlags],
    [
      "withChildPaymentRequired",
      () => withChildPaymentRequired(new Uint8Array(8)),
    ],
  ];

  it.each(constructors)("%s keeps wire byte 2 clear", (_name, build) => {
    expect(build()[2]).toBe(0);
  });

  it("no default-constructed grant lands bits in the univocity alg band (40–47)", () => {
    for (const [, build] of constructors) {
      const v = univocityFlagsUint(build());
      expect((v >> 40n) & 0xffn).toBe(0n);
    }
  });

  it("withChildPaymentRequired preserves — not clears — a caller's byte 2, so the guard sits with the constructors", () => {
    // Documents the trust boundary: constructors never set byte 2 uninvited,
    // and the mutator does not silently launder one that arrives set.
    const tampered = new Uint8Array(8);
    tampered[2] = 0x01; // GF_REQUIRES_USER_VERIFICATION (univocity 1<<40)
    expect(withChildPaymentRequired(tampered)[2]).toBe(0x01);
  });
});

describe("GF_REQUIRES_USER_VERIFICATION — explicit byte-2 opt-in (plan-2608-13)", () => {
  it("withRequiresUserVerification sets byte 2 mask 0x01 and nothing else", () => {
    const flags = withRequiresUserVerification(new Uint8Array(8));
    expect(flags.length).toBe(8);
    expect(flags[2]).toBe(0x01);
    expect(flags[3]).toBe(0);
    expect(flags[7]).toBe(0);
  });

  it("round-trips through the predicate; default grants carry no UV", () => {
    expect(
      hasRequiresUserVerification(
        withRequiresUserVerification(new Uint8Array(8)),
      ),
    ).toBe(true);
    expect(hasRequiresUserVerification(authLogBootstrapShapedFlags())).toBe(
      false,
    );
    expect(hasRequiresUserVerification(new Uint8Array([0, 0, 0x01]))).toBe(
      false, // short grants reject
    );
  });

  it("preserves other flag bytes and does not mutate its input", () => {
    const parent = authLogBootstrapShapedFlags(); // byte 3 = 0x03, byte 7 = 0x01
    const flags = withRequiresUserVerification(parent);
    expect(flags[2]).toBe(0x01);
    expect(flags[3]).toBe(0x03);
    expect(flags[7]).toBe(0x01);
    expect(parent[2]).toBe(0);
  });

  it("lands on univocity bit 40 exactly (byte 2 → big-endian uint256 bits 40–47)", () => {
    const flags = withRequiresUserVerification(new Uint8Array(8));
    const v = univocityFlagsUint(flags);
    expect(v).toBe(1n << 40n); // GF_REQUIRES_USER_VERIFICATION, nothing else
  });
});
