/**
 * Univocity genesis chain-binding e2e helpers (plan-0007 scenario).
 *
 * Provisions a forest genesis bound to a real Base Sepolia Univocity contract
 * against a **fixed** root log id so the "genesis exists before first checkpoint"
 * state can be re-tested. Identity and contract are env-overridable with stable
 * defaults; reset via `task cf:genesis:delete LOG_ID=<R>`.
 *
 * **Bootstrap alg:** forest genesis POST uses an ES256 COSE_Key (P-256 x‖y). The
 * contract under test must have been deployed with `ALG_ES256` and a 64-byte
 * bootstrap key (`abi.encodePacked(x, y)`). The default Safe-backed deployment at
 * `0x611dd70B…` uses `ALG_KS256` (-65799) with a 20-byte Safe address — that is
 * incompatible with canopy genesis and arbor anchor verification today.
 */

import { decode as decodeCbor } from "cbor-x";
import type { APIRequestContext } from "@playwright/test";
import { decodeBodyAsIntKeyMap } from "@e2e-canopy-api-src/cbor-api/cbor-map-utils.js";
import { COSE_EC2_X, COSE_EC2_Y } from "@e2e-canopy-api-src/cose/cose-key.js";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
} from "@e2e-canopy-api-src/forest/forest-genesis-labels.js";
import { E2E_STATIC_UNIVOCITY_GENESIS_LOG_ID } from "./e2e-static-log-ids.js";

/**
 * Default Base Sepolia ImutableUnivocity (Safe KS256 bootstrap). Used when
 * `E2E_UNIVOCITY_CONTRACT_ADDR` is unset; chain-binding specs skip unless the
 * on-chain bootstrap alg is ES256.
 */
export const DEFAULT_UNIVOCITY_CONTRACT_ADDR =
  "0x611dd70B2D36c87B29878089eD8a7aDc68E4441B";

/** Safe multisig used as KS256 bootstrap for {@link DEFAULT_UNIVOCITY_CONTRACT_ADDR}. */
export const DEFAULT_UNIVOCITY_KS256_SAFE_ADDR =
  "0x1528b86ff561f617602356efdbD05908a07AA788";

/** COSE `alg` for ES256 (forest genesis and ES256 Univocity bootstrap). */
export const COSE_ALG_ES256 = -7;

/** COSE `alg` for KS256 (Ethereum-address / ERC-1271 bootstrap on Univocity). */
export const COSE_ALG_KS256 = -65799;

const BOOTSTRAP_CONFIG_SELECTOR = "0x198865fe";

export interface OnChainBootstrapConfig {
  alg: number;
  key: Uint8Array;
}

export function univocityRpcUrlForE2e(): string {
  return (
    process.env.E2E_UNIVOCITY_RPC_URL ?? "https://sepolia.base.org"
  ).trim();
}

/** `eth_call` `bootstrapConfig()` on a Univocity deployment. */
export async function fetchOnChainBootstrapConfig(
  contractAddr?: string,
  rpcUrl?: string,
): Promise<OnChainBootstrapConfig> {
  const addr = (contractAddr ?? DEFAULT_UNIVOCITY_CONTRACT_ADDR).trim();
  const rpc = rpcUrl ?? univocityRpcUrlForE2e();
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: addr, data: BOOTSTRAP_CONFIG_SELECTOR }, "latest"],
    }),
  });
  if (!res.ok) {
    throw new Error(
      `RPC ${rpc} bootstrapConfig eth_call failed: ${res.status}`,
    );
  }
  const json = (await res.json()) as {
    result?: string;
    error?: { message?: string };
  };
  if (json.error?.message || !json.result || json.result === "0x") {
    throw new Error(
      `bootstrapConfig eth_call error: ${json.error?.message ?? "empty result"}`,
    );
  }
  return decodeBootstrapConfigResult(json.result);
}

function decodeBootstrapConfigResult(hex: string): OnChainBootstrapConfig {
  const raw = hex.replace(/^0x/, "");
  if (raw.length < 128) {
    throw new Error(
      `bootstrapConfig result too short: ${raw.length} hex chars`,
    );
  }
  const alg = decodeInt256Word(raw.slice(0, 64));
  const keyOffset = Number(BigInt(`0x${raw.slice(64, 128)}`)) * 2;
  const keyLen = Number(BigInt(`0x${raw.slice(keyOffset, keyOffset + 64)}`));
  const keyHex = raw.slice(keyOffset + 64, keyOffset + 64 + keyLen * 2);
  if (keyHex.length !== keyLen * 2) {
    throw new Error("bootstrapConfig key length mismatch in ABI decode");
  }
  return { alg, key: hexToBytes(keyHex) };
}

function decodeInt256Word(word64Hex: string): number {
  const v = BigInt(`0x${word64Hex}`);
  const max = 1n << 255n;
  const mod = 1n << 256n;
  const signed = v >= max ? v - mod : v;
  const n = Number(signed);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`bootstrap alg out of safe integer range: ${signed}`);
  }
  return n;
}

/**
 * Returns a skip reason when the contract bootstrap is not ES256 x‖y (forest
 * genesis cannot anchor to KS256 Safe deployments without stack changes).
 */
export async function es256ChainBindingSkipReason(
  contractAddr?: string,
): Promise<string | null> {
  const addr = (
    contractAddr ??
    process.env.E2E_UNIVOCITY_CONTRACT_ADDR ??
    DEFAULT_UNIVOCITY_CONTRACT_ADDR
  ).trim();
  let boot: OnChainBootstrapConfig;
  try {
    boot = await fetchOnChainBootstrapConfig(addr);
  } catch (e) {
    return `Could not read bootstrapConfig() for ${addr}: ${
      e instanceof Error ? e.message : String(e)
    }`;
  }
  if (boot.alg === COSE_ALG_ES256 && boot.key.length === 64) {
    return null;
  }
  const keyDesc =
    boot.key.length === 20
      ? `0x${Buffer.from(boot.key).toString("hex")} (20-byte address)`
      : `${boot.key.length}-byte key`;
  return (
    `Univocity ${addr} bootstrap is alg=${boot.alg} key=${keyDesc}; chain-binding ` +
    "e2e requires ALG_ES256 (-7) with a 64-byte x‖y bootstrap matching the " +
    "Custodian ES256 genesis key. The default deployment is KS256 + Safe " +
    `${DEFAULT_UNIVOCITY_KS256_SAFE_ADDR}. Deploy a new ImutableUnivocity with ` +
    "ES256_X/ES256_Y from the Custodian genesis key (univocity script/Deploy.s.sol), " +
    "set E2E_UNIVOCITY_CONTRACT_ADDR, then re-run."
  );
}

/** Default Base Sepolia EIP-155 chain id. */
export const DEFAULT_UNIVOCITY_CHAIN_ID = "84532";

/**
 * Default fixed root log id (R) for the chain-binding scenario. Stable so the
 * genesis persists across runs; delete via `task cf:genesis:delete` to reset.
 */
export const DEFAULT_UNIVOCITY_GENESIS_LOG_ID =
  E2E_STATIC_UNIVOCITY_GENESIS_LOG_ID;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Parse `E2E_UNIVOCITY_CONTRACT_ADDR` (or default) into 20 address bytes. */
export function univocityContractAddrBytes(): Uint8Array {
  const raw = (
    process.env.E2E_UNIVOCITY_CONTRACT_ADDR ?? DEFAULT_UNIVOCITY_CONTRACT_ADDR
  )
    .trim()
    .toLowerCase()
    .replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(raw)) {
    throw new Error(
      `E2E_UNIVOCITY_CONTRACT_ADDR must be a 20-byte (40 hex) address; got ${raw.length} hex chars`,
    );
  }
  return hexToBytes(raw);
}

/** `E2E_UNIVOCITY_CHAIN_ID` (or default Base Sepolia 84532). */
export function univocityGenesisChainId(): string {
  return (
    process.env.E2E_UNIVOCITY_CHAIN_ID ?? DEFAULT_UNIVOCITY_CHAIN_ID
  ).trim();
}

/** `E2E_UNIVOCITY_GENESIS_LOG_ID` (or default fixed UUID). */
export function univocityGenesisLogId(): string {
  return (
    process.env.E2E_UNIVOCITY_GENESIS_LOG_ID ?? DEFAULT_UNIVOCITY_GENESIS_LOG_ID
  ).trim();
}

export interface ParsedForestGenesisE2e {
  chainId: string;
  univocityAddr: Uint8Array;
  bootstrapLogId: Uint8Array;
  x: Uint8Array;
  y: Uint8Array;
}

function asBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Buffer.isBuffer(v)) return new Uint8Array(v);
  return null;
}

/**
 * `GET /api/forest/{logId}/genesis` (public) and decode the stored CBOR map.
 * @throws if the response is not 200 or the map is malformed.
 */
export async function getForestGenesisParsed(
  request: APIRequestContext,
  logId: string,
): Promise<ParsedForestGenesisE2e> {
  const res = await request.get(`/api/forest/${logId}/genesis`);
  if (res.status() !== 200) {
    throw new Error(
      `GET genesis for ${logId}: expected 200, got ${res.status()}: ${(
        await res.text()
      ).slice(0, 500)}`,
    );
  }
  const body = new Uint8Array(await res.body());
  const m = decodeBodyAsIntKeyMap(decodeCbor(body));
  if (!m) throw new Error("genesis response is not a CBOR map");

  const chainId = m.get(FOREST_GENESIS_LABEL_CHAIN_ID);
  const univocityAddr = asBytes(m.get(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR));
  const bootstrapLogId = asBytes(m.get(FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID));
  const x = asBytes(m.get(COSE_EC2_X));
  const y = asBytes(m.get(COSE_EC2_Y));
  if (typeof chainId !== "string") {
    throw new Error("genesis chain-id missing or not a string");
  }
  if (!univocityAddr || !bootstrapLogId || !x || !y) {
    throw new Error("genesis missing univocity-addr / bootstrap-logid / x / y");
  }
  return { chainId, univocityAddr, bootstrapLogId, x, y };
}
