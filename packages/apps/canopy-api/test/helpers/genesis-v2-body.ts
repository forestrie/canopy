import { normalizeHexAddress } from "@forestrie/chain-rpc";
import { COSE_ALG_ES256, COSE_ALG_KS256 } from "../../src/cose/cose-key.js";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_SCHEMA_V2,
} from "../../src/forest/forest-genesis-labels.js";
import {
  writePositiveGateCache,
  type OnboardGateCacheEnv,
} from "../../src/onboarding/onboard-gate-cache.js";

/** Inline unit-test chain binding (not a deployed contract). */
const TEST_GENESIS_UNIVOCITY_ADDR = new Uint8Array(20).fill(0x42);
const TEST_GENESIS_CHAIN_ID = "84532";

/**
 * Seed the univocity gate cache with the exact (alg, key) a genesis body
 * carries, so the chain-anchored bootstrapKey check (plan-2607-46 slice 01)
 * admits it without a unit test ever reaching a real RPC.
 */
export async function seedGenesisChainIdentity(
  env: OnboardGateCacheEnv,
  bodyMap: Map<number, unknown>,
): Promise<void> {
  const alg = bodyMap.get(FOREST_GENESIS_LABEL_GENESIS_ALG) as number;
  const key = bodyMap.get(FOREST_GENESIS_LABEL_BOOTSTRAP_KEY) as Uint8Array;
  const addr = bodyMap.get(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR) as Uint8Array;
  const chainId = bodyMap.get(FOREST_GENESIS_LABEL_CHAIN_ID) as string;
  const addrHex = normalizeHexAddress(
    `0x${Array.from(addr, (b) => b.toString(16).padStart(2, "0")).join("")}`,
  );
  if (!addrHex) throw new Error("seedGenesisChainIdentity: bad univocityAddr");
  await writePositiveGateCache(env, chainId, addrHex, { alg, key });
}

/** Valid v2 ES256 genesis POST body for pool / integration tests. */
export function validGenesisV2Es256CborMap(opts?: {
  bootstrapKey?: Uint8Array;
  univocityAddr?: Uint8Array;
  chainId?: string;
}): Map<number, unknown> {
  const key = opts?.bootstrapKey ?? new Uint8Array(64).fill(0x11);
  return new Map<number, unknown>([
    [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
    [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_ES256],
    [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, key],
    [
      FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
      opts?.univocityAddr ?? TEST_GENESIS_UNIVOCITY_ADDR,
    ],
    [FOREST_GENESIS_LABEL_CHAIN_ID, opts?.chainId ?? TEST_GENESIS_CHAIN_ID],
  ]);
}

/** Valid v2 KS256 genesis POST body for coordinator-forward tests. */
export function validGenesisV2Ks256CborMap(opts?: {
  bootstrapKey?: Uint8Array;
  univocityAddr?: Uint8Array;
  chainId?: string;
}): Map<number, unknown> {
  const key = opts?.bootstrapKey ?? new Uint8Array(20).fill(0xaa);
  return new Map<number, unknown>([
    [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
    [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_KS256],
    [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, key],
    [
      FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
      opts?.univocityAddr ?? TEST_GENESIS_UNIVOCITY_ADDR,
    ],
    [FOREST_GENESIS_LABEL_CHAIN_ID, opts?.chainId ?? TEST_GENESIS_CHAIN_ID],
  ]);
}
