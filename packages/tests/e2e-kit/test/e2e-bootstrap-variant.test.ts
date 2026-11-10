import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  es256GrantData64FromPrivateKeyPem,
  ks256AddressFromPrivateKeyHex,
  randomKs256PrivateKeyHex,
} from "@forestrie/grant-builder";
import {
  bootstrapVariantForGrantE2e,
  claimBootstrapVariant,
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

describe("claimBootstrapVariant", () => {
  const ES256_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const ES256_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const KS256_A = "0xcccccccccccccccccccccccccccccccccccccccc";
  const es256PemA = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  const es256PemB = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  const ks256KeyA = randomKs256PrivateKeyHex();

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-variant-pool-"));
    const file = join(dir, "pool.json");
    writeFileSync(
      file,
      JSON.stringify({
        contracts: [
          { alg: "es256", address: ES256_A, bootstrapPrivateKey: es256PemA },
          { alg: "es256", address: ES256_B, bootstrapPrivateKey: es256PemB },
          { alg: "ks256", address: KS256_A, bootstrapPrivateKey: ks256KeyA },
        ],
      }),
    );
    process.env.E2E_UNIVOCITY_CONTRACT_POOL_FILE = file;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.E2E_UNIVOCITY_CONTRACT_POOL_FILE;
  });

  test("binds each forest's variant to its own contract and bootstrap key", () => {
    const first = claimBootstrapVariant("es256", "forest one");
    const second = claimBootstrapVariant("es256", "forest two");

    expect(first.contractAddr).toBe(ES256_A);
    expect(first.contractAddrBytes).toEqual(new Uint8Array(20).fill(0xaa));
    expect(first.bootstrapPrivateKey()).toBe(es256PemA.trim());
    expect(second.contractAddr).toBe(ES256_B);
    expect(second.bootstrapPrivateKey()).toBe(es256PemB.trim());
  });

  test("returns the on-chain bootstrap key when it is the pooled key's public half", async () => {
    const onChain = {
      alg: COSE_ALG_KS256,
      key: ks256AddressFromPrivateKeyHex(ks256KeyA),
    };
    const fetchSpy = vi
      .spyOn(univocityGenesis, "fetchOnChainBootstrapConfig")
      .mockResolvedValue(onChain);
    const variant = claimBootstrapVariant("ks256", "forest");

    await expect(variant.fetchBootstrapKey()).resolves.toEqual(onChain);
    expect(fetchSpy).toHaveBeenCalledWith(KS256_A);
  });

  test("refuses a contract whose on-chain bootstrap key is not the pooled key", async () => {
    // A pool that pairs a contract with another contract's key would
    // otherwise surface as a genesis 422 far from its cause.
    vi.spyOn(univocityGenesis, "fetchOnChainBootstrapConfig").mockResolvedValue(
      {
        alg: COSE_ALG_ES256,
        key: es256GrantData64FromPrivateKeyPem(es256PemB),
      },
    );
    const variant = claimBootstrapVariant("es256", "forest");

    await expect(variant.fetchBootstrapKey()).rejects.toThrow(
      /contract 0xaaaa.* does not match/,
    );
  });
});
