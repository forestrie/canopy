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

  it("assertBootstrapMintE2eEnv accepts a contract pool in place of pinned contracts", () => {
    // Canopy's suite binds each forest to a pooled contract and its key; the
    // pinned per-alg addresses and key files are never set there.
    delete process.env.E2E_UNIVOCITY_ADDRESS_ES256_BOOTSTRAP;
    delete process.env.E2E_UNIVOCITY_ADDRESS_KS256_BOOTSTRAP;
    delete process.env.E2E_UNIVOCITY_ES256_BOOTSTRAP_PEM_FILE;
    delete process.env.E2E_UNIVOCITY_KS256_BOOTSTRAP_KEY_FILE;
    process.env.E2E_UNIVOCITY_CONTRACT_POOL_FILE = "/tmp/pool.json";

    expect(() => assertBootstrapMintE2eEnv()).not.toThrow();
  });

  it("assertBootstrapMintE2eEnv still requires the pinned key material without a pool", () => {
    // Lane suites pin one contract per alg; a missing key must fail here,
    // not as a genesis 422 later.
    delete process.env.E2E_UNIVOCITY_CONTRACT_POOL_FILE;
    delete process.env.E2E_UNIVOCITY_ES256_BOOTSTRAP_PEM_FILE;

    expect(() => assertBootstrapMintE2eEnv()).toThrow(
      /E2E_UNIVOCITY_ES256_BOOTSTRAP_PEM_FILE/,
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
