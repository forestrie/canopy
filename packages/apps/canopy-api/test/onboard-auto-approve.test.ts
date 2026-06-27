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
};

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
