import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertBootstrapMintE2eEnv,
  assertBootstrapReceiptE2eEnv,
} from "../src/e2e-env-guards.js";

describe("e2e-env-guards skip paths", () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    process.env.CANOPY_OPS_ADMIN_TOKEN = "ops-token";
    process.env.E2E_UNIVOCITY_ADDRESS_ES256_BOOTSTRAP =
      "0x0000000000000000000000000000000000000001";
    process.env.E2E_UNIVOCITY_ADDRESS_KS256_BOOTSTRAP =
      "0x0000000000000000000000000000000000000002";
    process.env.E2E_UNIVOCITY_ES256_BOOTSTRAP_PEM_FILE = "/tmp/es256.pem";
    process.env.E2E_UNIVOCITY_KS256_BOOTSTRAP_KEY_FILE = "/tmp/ks256.key";
    delete process.env.E2E_SKIP_UNIVOCITY_CHAIN_BINDING;
  });

  afterEach(() => {
    process.env = env;
  });

  it("assertBootstrapMintE2eEnv throws when Univocity provision was skipped", () => {
    process.env.E2E_SKIP_UNIVOCITY_CHAIN_BINDING = "true";
    expect(() => assertBootstrapMintE2eEnv()).toThrow(
      /SKIP_UNIVOCITY_PROVISION/,
    );
  });

  it("assertBootstrapReceiptE2eEnv throws when coordinator env is missing", () => {
    delete process.env.DELEGATION_COORDINATOR_URL;
    delete process.env.COORDINATOR_APP_TOKEN;
    expect(() => assertBootstrapReceiptE2eEnv()).toThrow(
      /DELEGATION_COORDINATOR_URL/,
    );
  });
});
