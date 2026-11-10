import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertOpsAdminE2eEnv,
  releaseChainBindingClaimE2e,
} from "../src/onboard-token-e2e.js";

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

describe("releaseChainBindingClaimE2e", () => {
  const env = process.env;
  const POOLED = "0x1111111111111111111111111111111111111111";
  const PINNED = "0x2222222222222222222222222222222222222222";
  let deleted: string[];
  const request = {
    delete: async (url: string) => {
      deleted.push(url);
      return { status: () => 404, text: async () => "" };
    },
  } as unknown as APIRequestContext;

  beforeEach(() => {
    process.env = { ...env, CANOPY_OPS_ADMIN_TOKEN: "ops-token" };
    deleted = [];
    const dir = mkdtempSync(join(tmpdir(), "e2e-pool-"));
    const poolFile = join(dir, "pool.json");
    writeFileSync(
      poolFile,
      JSON.stringify({
        contracts: [
          { alg: "es256", address: POOLED, bootstrapPrivateKey: "pem" },
        ],
      }),
    );
    process.env.E2E_UNIVOCITY_CONTRACT_POOL_FILE = poolFile;
  });

  afterEach(() => {
    process.env = env;
  });

  it("leaves a pooled contract's claim in place, so a reused contract is refused at the onboard mint", async () => {
    await releaseChainBindingClaimE2e(request, {
      chainId: "84532",
      univocityAddr: POOLED.toUpperCase().replace("0X", "0x"),
    });

    expect(deleted).toEqual([]);
  });

  it("still releases a pinned contract's claim from an earlier run", async () => {
    await releaseChainBindingClaimE2e(request, {
      chainId: "84532",
      univocityAddr: PINNED,
    });

    expect(deleted).toHaveLength(1);
    expect(decodeURIComponent(deleted[0]!)).toContain(PINNED.slice(2));
  });
});
