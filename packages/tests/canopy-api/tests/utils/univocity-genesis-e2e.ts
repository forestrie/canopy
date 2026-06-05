/**
 * Univocity genesis chain-binding e2e helpers (plan-0007 scenario).
 *
 * Provisions a forest genesis bound to a real Base Sepolia Univocity contract
 * against a **fixed** root log id so the "genesis exists before first checkpoint"
 * state can be re-tested. Identity and contract are env-overridable with stable
 * defaults; reset via `task cf:genesis:delete LOG_ID=<R>`.
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

/** Default Base Sepolia Univocity deployment under test (BaseScan-verified). */
export const DEFAULT_UNIVOCITY_CONTRACT_ADDR =
  "0x611dd70B2D36c87B29878089eD8a7aDc68E4441B";

/** Default Base Sepolia EIP-155 chain id. */
export const DEFAULT_UNIVOCITY_CHAIN_ID = "84532";

/**
 * Default fixed root log id (R) for the chain-binding scenario. Stable so the
 * genesis persists across runs; delete via `task cf:genesis:delete` to reset.
 */
export const DEFAULT_UNIVOCITY_GENESIS_LOG_ID =
  "b1a50611-dd70-42d3-9c87-611dd70b2441";

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
