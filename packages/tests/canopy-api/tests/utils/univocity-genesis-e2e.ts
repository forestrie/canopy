/**
 * Univocity genesis chain-binding e2e helpers (plan-0007 / plan-0032).
 *
 * Supports ES256 and KS256 forest genesis anchors (v2) matching on-chain
 * `bootstrapConfig()`.
 */

import { decode as decodeCbor } from "cbor-x";
import type { APIRequestContext } from "@playwright/test";
import { decodeBodyAsIntKeyMap } from "@e2e-canopy-api-src/cbor-api/cbor-map-utils.js";
import { COSE_EC2_X, COSE_EC2_Y } from "@e2e-canopy-api-src/cose/cose-key.js";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
} from "@e2e-canopy-api-src/forest/forest-genesis-labels.js";
import {
  E2E_STATIC_UNIVOCITY_GENESIS_LOG_ID_ES256,
  E2E_STATIC_UNIVOCITY_GENESIS_LOG_ID_KS256,
} from "./e2e-static-log-ids.js";

/** Default Base Sepolia KS256 ImutableUnivocity (Safe bootstrap). */
export const DEFAULT_KS256_BOOTSTRAP_CONTRACT_ADDR =
  "0x7A4E8ad88D6Df29FEBEc0d546d148Ed4bea8Cb94";

/** Default Base Sepolia ES256 ImutableUnivocity (PEM bootstrap). */
export const DEFAULT_ES256_BOOTSTRAP_CONTRACT_ADDR =
  "0xb5906A91eF30dA435Ff13d27619Bc6F76282d19D";

/** @deprecated Use {@link DEFAULT_KS256_BOOTSTRAP_CONTRACT_ADDR}. */
export const DEFAULT_UNIVOCITY_CONTRACT_ADDR =
  DEFAULT_KS256_BOOTSTRAP_CONTRACT_ADDR;

/** Safe multisig used as KS256 bootstrap for {@link DEFAULT_KS256_BOOTSTRAP_CONTRACT_ADDR}. */
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

function parseContractAddrBytes(
  rawEnv: string | undefined,
  fallback: string,
): Uint8Array {
  const raw = (rawEnv ?? fallback).trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(raw)) {
    throw new Error(
      `Univocity contract env must be a 20-byte (40 hex) address; got ${raw.length} hex chars`,
    );
  }
  return hexToBytes(raw);
}

/** `E2E_UNIVOCITY_ADDRESS_KS256_BOOTSTRAP` (or KS256 default). */
export function ks256BootstrapContractAddr(): string {
  return (
    process.env.E2E_UNIVOCITY_ADDRESS_KS256_BOOTSTRAP ??
    DEFAULT_KS256_BOOTSTRAP_CONTRACT_ADDR
  ).trim();
}

/** `E2E_UNIVOCITY_ADDRESS_ES256_BOOTSTRAP` (or ES256 default). */
export function es256BootstrapContractAddr(): string {
  return (
    process.env.E2E_UNIVOCITY_ADDRESS_ES256_BOOTSTRAP ??
    DEFAULT_ES256_BOOTSTRAP_CONTRACT_ADDR
  ).trim();
}

/** Parse KS256 bootstrap contract address into 20 bytes. */
export function ks256BootstrapContractAddrBytes(): Uint8Array {
  return parseContractAddrBytes(
    process.env.E2E_UNIVOCITY_ADDRESS_KS256_BOOTSTRAP,
    DEFAULT_KS256_BOOTSTRAP_CONTRACT_ADDR,
  );
}

/** Parse ES256 bootstrap contract address into 20 bytes. */
export function es256BootstrapContractAddrBytes(): Uint8Array {
  return parseContractAddrBytes(
    process.env.E2E_UNIVOCITY_ADDRESS_ES256_BOOTSTRAP,
    DEFAULT_ES256_BOOTSTRAP_CONTRACT_ADDR,
  );
}

/** @deprecated Use {@link ks256BootstrapContractAddrBytes} or {@link es256BootstrapContractAddrBytes}. */
export function univocityContractAddrBytes(): Uint8Array {
  return ks256BootstrapContractAddrBytes();
}

/** `eth_call` `bootstrapConfig()` on a Univocity deployment. */
export async function fetchOnChainBootstrapConfig(
  contractAddr?: string,
  rpcUrl?: string,
): Promise<OnChainBootstrapConfig> {
  const addr = (contractAddr ?? ks256BootstrapContractAddr()).trim();
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

async function univocityChainBindingSkipReason(
  contractAddr: string,
  requiredAlg: number,
): Promise<string | null> {
  let boot: OnChainBootstrapConfig;
  try {
    boot = await fetchOnChainBootstrapConfig(contractAddr);
  } catch (e) {
    return `Could not read bootstrapConfig() for ${contractAddr}: ${
      e instanceof Error ? e.message : String(e)
    }`;
  }
  if (boot.alg === COSE_ALG_ES256 && boot.key.length === 64) {
    return requiredAlg === COSE_ALG_ES256
      ? null
      : "contract bootstrap is ES256, spec requires KS256";
  }
  if (boot.alg === COSE_ALG_KS256 && boot.key.length === 20) {
    return requiredAlg === COSE_ALG_KS256
      ? null
      : "contract bootstrap is KS256, spec requires ES256";
  }
  const keyDesc =
    boot.key.length === 20
      ? `0x${Buffer.from(boot.key).toString("hex")} (20-byte address)`
      : `${boot.key.length}-byte key`;
  return (
    `Univocity ${contractAddr} bootstrap is alg=${boot.alg} key=${keyDesc}; ` +
    "expected ES256 (-7) with 64-byte x‖y or KS256 (-65799) with 20-byte address."
  );
}

export async function es256ChainBindingSkipReason(
  contractAddr?: string,
): Promise<string | null> {
  return univocityChainBindingSkipReason(
    (contractAddr ?? es256BootstrapContractAddr()).trim(),
    COSE_ALG_ES256,
  );
}

export async function ks256ChainBindingSkipReason(
  contractAddr?: string,
): Promise<string | null> {
  return univocityChainBindingSkipReason(
    (contractAddr ?? ks256BootstrapContractAddr()).trim(),
    COSE_ALG_KS256,
  );
}

/** Default Base Sepolia EIP-155 chain id. */
export const DEFAULT_UNIVOCITY_CHAIN_ID = "84532";

/** @deprecated Use {@link DEFAULT_UNIVOCITY_GENESIS_LOG_ID_KS256}. */
export const DEFAULT_UNIVOCITY_GENESIS_LOG_ID =
  E2E_STATIC_UNIVOCITY_GENESIS_LOG_ID_KS256;

export const DEFAULT_UNIVOCITY_GENESIS_LOG_ID_KS256 =
  E2E_STATIC_UNIVOCITY_GENESIS_LOG_ID_KS256;

export const DEFAULT_UNIVOCITY_GENESIS_LOG_ID_ES256 =
  E2E_STATIC_UNIVOCITY_GENESIS_LOG_ID_ES256;

/** `E2E_UNIVOCITY_CHAIN_ID` (or default Base Sepolia 84532). */
export function univocityGenesisChainId(): string {
  return (
    process.env.E2E_UNIVOCITY_CHAIN_ID ?? DEFAULT_UNIVOCITY_CHAIN_ID
  ).trim();
}

/** `E2E_UNIVOCITY_GENESIS_LOG_ID_KS256` (or KS256 static default). */
export function ks256GenesisLogId(): string {
  return (
    process.env.E2E_UNIVOCITY_GENESIS_LOG_ID_KS256 ??
    E2E_STATIC_UNIVOCITY_GENESIS_LOG_ID_KS256
  ).trim();
}

/** `E2E_UNIVOCITY_GENESIS_LOG_ID_ES256` (or ES256 static default). */
export function es256GenesisLogId(): string {
  return (
    process.env.E2E_UNIVOCITY_GENESIS_LOG_ID_ES256 ??
    E2E_STATIC_UNIVOCITY_GENESIS_LOG_ID_ES256
  ).trim();
}

/** @deprecated Use {@link ks256GenesisLogId} or {@link es256GenesisLogId}. */
export function univocityGenesisLogId(): string {
  return ks256GenesisLogId();
}

export interface ParsedForestGenesisE2e {
  chainId: string;
  univocityAddr: Uint8Array;
  bootstrapLogId: Uint8Array;
  /** ES256 v1 / derived from v2 bootstrapKey. */
  x?: Uint8Array;
  y?: Uint8Array;
  /** v2 opaque bootstrap (64 ES256 or 20 KS256). */
  bootstrapAlg?: number;
  bootstrapKey?: Uint8Array;
}

function asBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Buffer.isBuffer(v)) return new Uint8Array(v);
  return null;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
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
  const bootstrapAlgRaw = m.get(FOREST_GENESIS_LABEL_GENESIS_ALG);
  const bootstrapKey = asBytes(m.get(FOREST_GENESIS_LABEL_BOOTSTRAP_KEY));
  const x = asBytes(m.get(COSE_EC2_X));
  const y = asBytes(m.get(COSE_EC2_Y));
  if (typeof chainId !== "string") {
    throw new Error("genesis chain-id missing or not a string");
  }
  if (!univocityAddr || !bootstrapLogId) {
    throw new Error("genesis missing univocity-addr / bootstrap-logid");
  }
  const parsed: ParsedForestGenesisE2e = {
    chainId,
    univocityAddr,
    bootstrapLogId,
  };
  if (bootstrapKey && bootstrapAlgRaw !== undefined) {
    const alg =
      typeof bootstrapAlgRaw === "bigint"
        ? Number(bootstrapAlgRaw)
        : Number(bootstrapAlgRaw);
    parsed.bootstrapAlg = alg;
    parsed.bootstrapKey = bootstrapKey;
    if (alg === COSE_ALG_ES256 && bootstrapKey.length === 64) {
      parsed.x = bootstrapKey.slice(0, 32);
      parsed.y = bootstrapKey.slice(32, 64);
    }
  }
  if (x && y) {
    parsed.x = x;
    parsed.y = y;
  }
  if (!parsed.bootstrapKey && (!parsed.x || !parsed.y)) {
    throw new Error(
      "genesis missing bootstrap key (v1 x/y or v2 bootstrapKey)",
    );
  }
  return parsed;
}
