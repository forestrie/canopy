/** Minimal JSON-RPC helper for chain reads (eth_getCode, etc.). */

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export async function ethRpc(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`RPC ${method} failed: ${res.status}`);
  }
  const json = (await res.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (json.error?.message) {
    throw new Error(json.error.message);
  }
  return json.result;
}

export function normalizeHexAddress(addr: string): string | null {
  const trimmed = addr.trim().toLowerCase();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-f]{40}$/.test(hex)) return null;
  return hex;
}

export async function hasContractCodeAt(
  rpcUrl: string,
  addressHex: string,
): Promise<boolean> {
  const result = (await ethRpc(rpcUrl, "eth_getCode", [
    `0x${addressHex}`,
    "latest",
  ])) as string;
  if (typeof result !== "string") return false;
  const stripped = result.replace(/^0x/i, "");
  return stripped.length > 0 && !/^0+$/.test(stripped);
}

export function hexAddressToBytes(hex40: string): Uint8Array {
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    out[i] = Number.parseInt(hex40.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export { bytesToHex };
