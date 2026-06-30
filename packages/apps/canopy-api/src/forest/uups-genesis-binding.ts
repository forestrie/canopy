import { getAddress, type Address } from "viem";
import { predictCreate3Address } from "../univocity/create3-address.js";
import { uupsProxySaltString } from "../univocity/uups-proxy-salt.js";
import { bytesEqual } from "../cbor-api/cbor-map-utils.js";
import { asGenesisUint8Array } from "./genesis-wire.js";

/** Default shared CREATE3 factory (Forestrie deployment.json). */
export const DEFAULT_CREATE3_FACTORY =
  "0x988e1Ef32F200E84197266eC0Fd36cC9a1d849dF" as Address;

export function resolveCreate3FactoryAddress(env?: {
  CREATE3_FACTORY_ADDRESS?: string;
}): Address {
  const raw = env?.CREATE3_FACTORY_ADDRESS?.trim();
  if (!raw) return DEFAULT_CREATE3_FACTORY;
  return getAddress(raw);
}

export function addressBytesToHex(addr: Uint8Array): Address {
  return getAddress(
    `0x${Array.from(addr, (b) => b.toString(16).padStart(2, "0")).join("")}`,
  );
}

/** Assert univocity-addr matches counterfactual CREATE3 prediction for logId. */
export function assertCounterfactualUupsAddress(
  logIdRouteSegment: string,
  deployerBytes: Uint8Array,
  univocityAddr: Uint8Array,
  factory: Address = DEFAULT_CREATE3_FACTORY,
): boolean {
  const deployer = addressBytesToHex(deployerBytes);
  const expected = predictCreate3Address(
    deployer,
    uupsProxySaltString(logIdRouteSegment),
    factory,
  );
  const expectedBytes = hexToBytes(expected);
  return bytesEqual(univocityAddr, expectedBytes);
}

function hexToBytes(hex: Address): Uint8Array {
  const stripped = hex.slice(2);
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) {
    out[i] = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function parseUnivocityDeployerRequired(
  v: unknown,
): Uint8Array | "invalid" {
  const b = asGenesisUint8Array(v);
  if (!b || b.length !== 20) return "invalid";
  return b;
}
