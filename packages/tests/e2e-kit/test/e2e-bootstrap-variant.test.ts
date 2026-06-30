import { afterEach, describe, expect, test, vi } from "vitest";
import {
  bootstrapVariantForGrantE2e,
  getBootstrapVariant,
} from "../src/e2e-bootstrap-variant.js";
import * as univocityGenesis from "../src/univocity-genesis-e2e.js";
import {
  COSE_ALG_ES256,
  COSE_ALG_KS256,
} from "../src/univocity-genesis-e2e.js";
import { KS256_UNIVOCITY_MANIFEST_PLACEHOLDER } from "../src/system-test-manifest-constants.js";

describe("bootstrapVariantForGrantE2e", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.E2E_UNIVOCITY_ADDRESS_KS256_BOOTSTRAP;
    delete process.env.E2E_UNIVOCITY_KS256_BOOTSTRAP_KEY_FILE;
  });

  test("returns ks256 when manifest ks256 pin is live and chain binding passes", async () => {
    process.env.E2E_UNIVOCITY_ADDRESS_KS256_BOOTSTRAP =
      "0x6055f9615Edc5b4B7d8C87c75E1B5EE45583492C";
    process.env.E2E_UNIVOCITY_ADDRESS_ES256_BOOTSTRAP =
      "0x7A4E8ad88D6Df29FEBEc0d546d148Ed4bea8Cb94";
    vi.spyOn(univocityGenesis, "ks256ChainBindingSkipReason").mockResolvedValue(
      null,
    );

    const variant = await bootstrapVariantForGrantE2e();
    expect(variant.id).toBe("ks256");
  });

  test("returns ks256 when es256 pin on-chain bootstrap is KS256", async () => {
    process.env.E2E_UNIVOCITY_ADDRESS_KS256_BOOTSTRAP =
      KS256_UNIVOCITY_MANIFEST_PLACEHOLDER;
    process.env.E2E_UNIVOCITY_ADDRESS_ES256_BOOTSTRAP =
      "0x7A4E8ad88D6Df29FEBEc0d546d148Ed4bea8Cb94";
    vi.spyOn(univocityGenesis, "fetchOnChainBootstrapConfig").mockResolvedValue(
      {
        alg: COSE_ALG_KS256,
        key: new Uint8Array(20).fill(0xab),
      },
    );

    const variant = await bootstrapVariantForGrantE2e();
    expect(variant.id).toBe("ks256");
  });

  test("returns es256 when es256 pin on-chain bootstrap is ES256", async () => {
    process.env.E2E_UNIVOCITY_ADDRESS_KS256_BOOTSTRAP =
      KS256_UNIVOCITY_MANIFEST_PLACEHOLDER;
    process.env.E2E_UNIVOCITY_ADDRESS_ES256_BOOTSTRAP =
      "0x611dd70B2D36c87B29878089eD8a7aDc68E4441B";
    vi.spyOn(univocityGenesis, "fetchOnChainBootstrapConfig").mockResolvedValue(
      {
        alg: COSE_ALG_ES256,
        key: new Uint8Array(64).fill(0xcd),
      },
    );

    const variant = await bootstrapVariantForGrantE2e();
    expect(variant.id).toBe("es256");
  });

  test("getBootstrapVariant resolves known ids", () => {
    expect(getBootstrapVariant("es256").id).toBe("es256");
    expect(getBootstrapVariant("ks256").id).toBe("ks256");
  });
});
