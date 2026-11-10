import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  claimUnivocityContract,
  univocityContractPoolSkipReason,
} from "../src/univocity-contract-pool.js";

const ES256_A = "0x1111111111111111111111111111111111111111";
const ES256_B = "0x2222222222222222222222222222222222222222";
const KS256_A = "0x3333333333333333333333333333333333333333";

function writePool(contracts: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "e2e-pool-"));
  const file = join(dir, "pool.json");
  writeFileSync(file, JSON.stringify({ contracts }));
  return file;
}

const pool = [
  { alg: "es256", address: ES256_A, bootstrapPrivateKey: "pem-a" },
  { alg: "ks256", address: KS256_A, bootstrapPrivateKey: "0xkey-a" },
  { alg: "es256", address: ES256_B, bootstrapPrivateKey: "pem-b" },
];

describe("claimUnivocityContract", () => {
  beforeEach(() => {
    process.env.E2E_UNIVOCITY_CONTRACT_POOL_FILE = writePool(pool);
  });
  afterEach(() => {
    delete process.env.E2E_UNIVOCITY_CONTRACT_POOL_FILE;
  });

  test("hands each contract of an alg to exactly one forest", () => {
    const first = claimUnivocityContract("es256", "forest one");
    const second = claimUnivocityContract("es256", "forest two");

    expect(first).toEqual({
      alg: "es256",
      address: ES256_A,
      bootstrapPrivateKey: "pem-a",
    });
    expect(second.address).toBe(ES256_B);
    expect(claimUnivocityContract("ks256", "forest three").address).toBe(
      KS256_A,
    );
  });

  test("reads a pool that records the chain it was deployed to", () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-pool-"));
    const file = join(dir, "pool.json");
    writeFileSync(file, JSON.stringify({ chainId: "84532", contracts: pool }));
    process.env.E2E_UNIVOCITY_CONTRACT_POOL_FILE = file;

    expect(claimUnivocityContract("ks256", "forest one").address).toBe(KS256_A);
  });

  test("refuses a claim once every contract of the alg is taken", () => {
    claimUnivocityContract("ks256", "forest one");

    expect(() => claimUnivocityContract("ks256", "forest two")).toThrow(
      /pool exhausted: all 1 ks256 contracts/,
    );
  });

  test("a contract claimed by an earlier worker process is not handed out again", async () => {
    // A Playwright retry runs in a new worker process: module state does not
    // survive, the claim must.
    claimUnivocityContract("es256", "failed attempt");
    vi.resetModules();
    const freshWorker = await import("../src/univocity-contract-pool.js");

    expect(freshWorker.claimUnivocityContract("es256", "retry").address).toBe(
      ES256_B,
    );
  });

  test("refuses a pool entry that is not a usable contract", () => {
    process.env.E2E_UNIVOCITY_CONTRACT_POOL_FILE = writePool([
      { alg: "es256", address: "0x1234", bootstrapPrivateKey: "pem" },
    ]);

    expect(() => claimUnivocityContract("es256", "forest")).toThrow(
      /contract 0 .* address/,
    );
  });

  test("names the missing pool when none is configured", () => {
    delete process.env.E2E_UNIVOCITY_CONTRACT_POOL_FILE;

    expect(() => claimUnivocityContract("es256", "forest")).toThrow(
      /E2E_UNIVOCITY_CONTRACT_POOL_FILE/,
    );
  });
});

describe("univocityContractPoolSkipReason", () => {
  afterEach(() => {
    delete process.env.E2E_UNIVOCITY_CONTRACT_POOL_FILE;
    delete process.env.E2E_SKIP_UNIVOCITY_CHAIN_BINDING;
  });

  test("runs when the pool holds a contract of the alg", () => {
    process.env.E2E_UNIVOCITY_CONTRACT_POOL_FILE = writePool(pool);

    expect(univocityContractPoolSkipReason("ks256")).toBeNull();
  });

  test("skips when no pool is configured", () => {
    expect(univocityContractPoolSkipReason("es256")).toMatch(
      /E2E_UNIVOCITY_CONTRACT_POOL_FILE is not set/,
    );
  });

  test("skips when the pool has no contract of the alg", () => {
    process.env.E2E_UNIVOCITY_CONTRACT_POOL_FILE = writePool([pool[0]]);

    expect(univocityContractPoolSkipReason("ks256")).toMatch(
      /no ks256 contracts/,
    );
  });

  test("skips when chain binding is switched off", () => {
    process.env.E2E_UNIVOCITY_CONTRACT_POOL_FILE = writePool(pool);
    process.env.E2E_SKIP_UNIVOCITY_CHAIN_BINDING = "true";

    expect(univocityContractPoolSkipReason("es256")).toMatch(
      /SKIP_UNIVOCITY_PROVISION/,
    );
  });
});
