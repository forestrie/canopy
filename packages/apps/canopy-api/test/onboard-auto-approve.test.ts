import { describe, expect, it } from "vitest";
import { shouldAutoApproveRequest } from "../src/onboarding/onboard-auto-approve.js";
import type { OnboardRequestRecord } from "../src/onboarding/onboard-request-record.js";

const baseRecord: OnboardRequestRecord = {
  requestId: "r1",
  status: "pending",
  label: "dev-fork",
  chainBinding: { chainId: "84532", univocityAddr: "aa".repeat(20) },
  contactEmail: "a@b.com",
  redeemCodeHash: "abc",
  createdAt: 1,
  expiresAt: 9999999999,
  attestationClaimKey: "payments/used-attestations/test",
};

/** Auto-approve config under which {@link baseRecord} is approved. */
const AUTO_APPROVE_ENV = { ONBOARD_AUTO_APPROVE: "true" };

const SUPPORTED_CHAINS_RPC = JSON.stringify({
  "84532": ["https://x"],
  "1": ["https://y"],
});

describe("onboard auto-approve", () => {
  it("default off does not auto-approve", () => {
    expect(shouldAutoApproveRequest({}, baseRecord)).toBe(false);
  });

  it("approves when chain in allowlist", () => {
    expect(
      shouldAutoApproveRequest(
        {
          ONBOARD_AUTO_APPROVE: "true",
          ONBOARD_AUTO_APPROVE_CHAIN_IDS: "84532,1",
          SUPPORTED_CHAINS_RPC,
        },
        baseRecord,
      ),
    ).toBe(true);
  });

  it("rejects disallowed chain", () => {
    expect(
      shouldAutoApproveRequest(
        {
          ONBOARD_AUTO_APPROVE: "true",
          ONBOARD_AUTO_APPROVE_CHAIN_IDS: "1",
          SUPPORTED_CHAINS_RPC,
        },
        baseRecord,
      ),
    ).toBe(false);
  });

  it("respects label prefix", () => {
    expect(
      shouldAutoApproveRequest(
        {
          ONBOARD_AUTO_APPROVE: "true",
          ONBOARD_AUTO_APPROVE_CHAIN_IDS: "84532",
          ONBOARD_AUTO_APPROVE_LABEL_PREFIX: "prod-",
          SUPPORTED_CHAINS_RPC,
        },
        baseRecord,
      ),
    ).toBe(false);
  });

  // A record without the claim key was created before single-use claims
  // and is forfeit, whether or not it was marked attested (plan-2611-11
  // Q49).
  it.each([
    ["with no attestation mark", {}],
    ["marked attested before single-use claims", { attested: true }],
  ])("never auto-approves a record %s", (_what, extra) => {
    const preDeploy: Record<string, unknown> = { ...baseRecord, ...extra };
    delete preDeploy.attestationClaimKey;
    expect(shouldAutoApproveRequest(AUTO_APPROVE_ENV, baseRecord)).toBe(true);
    expect(
      shouldAutoApproveRequest(
        AUTO_APPROVE_ENV,
        preDeploy as unknown as OnboardRequestRecord,
      ),
    ).toBe(false);
  });

  it("never auto-approves when NODE_ENV is prod", () => {
    expect(
      shouldAutoApproveRequest(
        {
          NODE_ENV: "prod",
          ONBOARD_AUTO_APPROVE: "true",
          ONBOARD_AUTO_APPROVE_CHAIN_IDS: "84532",
        },
        baseRecord,
      ),
    ).toBe(false);
  });
});
