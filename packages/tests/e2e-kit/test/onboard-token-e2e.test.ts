import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertOpsAdminE2eEnv } from "../src/onboard-token-e2e.js";

describe("assertOpsAdminE2eEnv", () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
  });

  afterEach(() => {
    process.env = env;
  });

  it("throws when CANOPY_OPS_ADMIN_TOKEN is missing", () => {
    delete process.env.CANOPY_OPS_ADMIN_TOKEN;
    expect(() => assertOpsAdminE2eEnv()).toThrow(/CANOPY_OPS_ADMIN_TOKEN/);
  });

  it("does not throw when token is set", () => {
    process.env.CANOPY_OPS_ADMIN_TOKEN = "ops-token";
    expect(() => assertOpsAdminE2eEnv()).not.toThrow();
  });
});
