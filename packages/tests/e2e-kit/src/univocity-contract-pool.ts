/**
 * Freshly deployed univocity contracts for the canopy system suite: one per
 * forest.
 *
 * A univocity contract has exactly one root log, set by the first checkpoint
 * it accepts ([protocol P14](https://github.com/forestrie/protocol/blob/main/rules/platform.md#p14--one-instance-root-set-once-global-logidr-uniqueness)).
 * A second forest on the same contract never anchors, so its child logs stay
 * pending at canopy admission
 * ([devdocs ADR-0075](https://github.com/forestrie/devdocs/blob/main/adr/adr-0075-sec-child-root-claimed-once.md)).
 * Provisioning (`taskfiles/e2e-univocity-provision-pool.sh`) therefore deploys
 * a pool of contracts per bootstrap alg and writes it to the file named by
 * {@link CONTRACT_POOL_FILE_ENV}; every forest a spec creates claims one.
 *
 * Claims are files created exclusively beside the pool file, so they hold
 * across Playwright worker processes: a retried test claims a fresh contract
 * instead of the one its failed attempt may already have rooted.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** Env var naming the JSON pool file provisioning writes. */
export const CONTRACT_POOL_FILE_ENV = "E2E_UNIVOCITY_CONTRACT_POOL_FILE";

/** Bootstrap algs a pooled contract can carry on chain. */
export type UnivocityPoolAlg = "es256" | "ks256";

/**
 * One freshly deployed contract and the private half of the bootstrap key its
 * `bootstrapConfig()` carries. Nothing else has used it until it is claimed.
 */
export interface UnivocityE2eContract {
  alg: UnivocityPoolAlg;
  /** 0x-prefixed 20-byte contract address. */
  address: string;
  /** ES256: the PKCS#8 PEM. KS256: the wallet private key as hex. */
  bootstrapPrivateKey: string;
}

/**
 * Claim the next unclaimed contract of `alg` for one forest.
 *
 * @param purpose names the forest; it is written into the claim so a run's
 *   claims directory shows which spec took which contract.
 * @throws when no pool is configured, the pool is malformed, or every
 *   contract of `alg` is already claimed.
 */
export function claimUnivocityContract(
  alg: UnivocityPoolAlg,
  purpose: string,
): UnivocityE2eContract {
  const poolFile = requirePoolFile();
  const candidates = readPool(poolFile).filter((c) => c.alg === alg);
  const claimsDir = `${poolFile}.claims`;
  mkdirSync(claimsDir, { recursive: true });
  for (const contract of candidates) {
    if (tryClaim(join(claimsDir, contract.address.toLowerCase()), purpose)) {
      return contract;
    }
  }
  throw new Error(
    `univocity contract pool exhausted: all ${candidates.length} ${alg} ` +
      `contracts in ${poolFile} are claimed (see ${claimsDir}). Provision ` +
      `more with E2E_UNIVOCITY_POOL_${alg.toUpperCase()}.`,
  );
}

/**
 * Why specs needing a fresh `alg` contract cannot run, or null when they can.
 * Mirrors {@link univocityProvisionSkipReason} for the pinned contracts.
 */
export function univocityContractPoolSkipReason(
  alg: UnivocityPoolAlg,
): string | null {
  if (process.env.E2E_SKIP_UNIVOCITY_CHAIN_BINDING?.trim() === "true") {
    return "Univocity provision skipped (SKIP_UNIVOCITY_PROVISION)";
  }
  const poolFile = process.env[CONTRACT_POOL_FILE_ENV]?.trim();
  if (!poolFile) {
    return (
      `${CONTRACT_POOL_FILE_ENV} is not set: run task test:e2e:preflight, ` +
      "which provisions the contract pool"
    );
  }
  if (!readPool(poolFile).some((c) => c.alg === alg)) {
    return `the contract pool ${poolFile} has no ${alg} contracts`;
  }
  return null;
}

/**
 * Whether `address` (hex, with or without 0x) is one of the configured pool's
 * contracts; false when no pool is configured. A pooled contract is fresh and
 * serves exactly one forest, so no earlier run can hold its instance claim.
 */
export function isPooledUnivocityContract(address: string): boolean {
  const poolFile = process.env[CONTRACT_POOL_FILE_ENV]?.trim();
  if (!poolFile) return false;
  const want = address.trim().toLowerCase().replace(/^0x/, "");
  return readPool(poolFile).some(
    (c) => c.address.slice(2).toLowerCase() === want,
  );
}

function requirePoolFile(): string {
  const poolFile = process.env[CONTRACT_POOL_FILE_ENV]?.trim();
  if (!poolFile) {
    throw new Error(
      `${CONTRACT_POOL_FILE_ENV} is required: run task test:e2e:preflight, ` +
        "which provisions one univocity contract per forest",
    );
  }
  return poolFile;
}

/** Create the claim file only if no one has; false when it already exists. */
function tryClaim(claimFile: string, purpose: string): boolean {
  let fd: number;
  try {
    fd = openSync(claimFile, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, `${purpose}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

function readPool(poolFile: string): UnivocityE2eContract[] {
  const parsed = JSON.parse(readFileSync(poolFile, "utf8")) as {
    contracts?: unknown;
  };
  if (!Array.isArray(parsed.contracts)) {
    throw new Error(`contract pool ${poolFile} has no "contracts" array`);
  }
  return parsed.contracts.map((entry, i) => parsePoolEntry(poolFile, i, entry));
}

function parsePoolEntry(
  poolFile: string,
  index: number,
  entry: unknown,
): UnivocityE2eContract {
  const e = (entry ?? {}) as Record<string, unknown>;
  const where = `contract pool ${poolFile}: contract ${index}`;
  if (e.alg !== "es256" && e.alg !== "ks256") {
    throw new Error(`${where} has alg ${String(e.alg)}, not es256 or ks256`);
  }
  if (typeof e.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(e.address)) {
    throw new Error(`${where} has no 0x-prefixed 20-byte address`);
  }
  if (
    typeof e.bootstrapPrivateKey !== "string" ||
    e.bootstrapPrivateKey.trim() === ""
  ) {
    throw new Error(`${where} has no bootstrapPrivateKey`);
  }
  return {
    alg: e.alg,
    address: e.address,
    bootstrapPrivateKey: e.bootstrapPrivateKey.trim(),
  };
}
