/**
 * Shared parse/validate helpers for forest genesis CBOR private labels.
 */

export function asGenesisUint8Array(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
}

/** v0/v1 read: null when absent; invalid when present but wrong shape. */
export function parseUnivocityAddrOptional(
  v: unknown,
): Uint8Array | null | "invalid" {
  if (v === null || v === undefined) return null;
  const b = asGenesisUint8Array(v);
  if (!b) return "invalid";
  if (b.length !== 20) return "invalid";
  return b;
}

/** v1 POST: required 20-byte address. */
export function parseUnivocityAddrRequired(
  v: unknown,
): Uint8Array | "invalid" {
  const res = parseUnivocityAddrOptional(v);
  if (res === null) return "invalid";
  return res;
}

/** Legacy v0 read: optional uint32 array. */
export function parseLegacyChainIds(
  v: unknown,
): number[] | null | "invalid" {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return "invalid";
  if (v.length === 0) return "invalid";
  const out: number[] = [];
  for (const item of v) {
    const n =
      typeof item === "bigint"
        ? Number(item)
        : typeof item === "number"
          ? item
          : Number(item);
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return "invalid";
    out.push(n);
  }
  return out;
}

const CHAIN_ID_RE = /^[0-9]{1,10}$/;

/** v1 POST and v1 stored objects: decimal EIP-155 chain id string. */
export function parseChainIdString(v: unknown): string | "invalid" {
  if (typeof v !== "string") return "invalid";
  const s = v.trim();
  if (!CHAIN_ID_RE.test(s)) return "invalid";
  return s;
}

export interface ForestGenesisChainBinding {
  address: Uint8Array;
  chainId: string;
}
