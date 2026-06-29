import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decode as decodeCbor } from "cbor-x";
import { univocityProvisionSkipReason } from "../src/univocity-genesis-e2e.js";

describe("univocityProvisionSkipReason", () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
  });

  afterEach(() => {
    process.env = env;
  });

  it("returns skip message when E2E_SKIP_UNIVOCITY_CHAIN_BINDING is true", () => {
    process.env.E2E_SKIP_UNIVOCITY_CHAIN_BINDING = "true";
    expect(univocityProvisionSkipReason()).toContain(
      "SKIP_UNIVOCITY_PROVISION",
    );
  });

  it("returns null when provision env is present", () => {
    process.env.E2E_UNIVOCITY_ADDRESS_ES256_BOOTSTRAP =
      "0x0000000000000000000000000000000000000001";
    process.env.E2E_UNIVOCITY_ADDRESS_KS256_BOOTSTRAP =
      "0x0000000000000000000000000000000000000002";
    expect(univocityProvisionSkipReason()).toBeNull();
  });

  it("returns preflight hint when ES256 bootstrap address is missing", () => {
    delete process.env.E2E_UNIVOCITY_ADDRESS_ES256_BOOTSTRAP;
    process.env.E2E_UNIVOCITY_ADDRESS_KS256_BOOTSTRAP =
      "0x0000000000000000000000000000000000000002";
    expect(univocityProvisionSkipReason()).toContain("preflight");
  });
});
