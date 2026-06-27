/**
 * JSON-RPC 2.0 helpers for EVM chain reads used by canopy-api KS256 and
 * onboarding. RPC URL lists come from `parseSupportedChainsRpc` via forest
 * genesis `chainBinding.chainId` — see
 * [ADR-0010 supported chains RPC](https://github.com/forestrie/canopy/blob/main/docs/adr/adr-0010-supported-chains-rpc-config.md).
 * Assumes callers pass fully resolved URLs (no `${env:VAR}` at runtime).
 */

/** Per-request timeout for a single JSON-RPC HTTP call. */
export interface EthRpcOptions {
  /** Maximum wait in ms; defaults to 5000 when omitted or non-positive. */
  timeoutMs?: number;
}

/**
 * Resolve effective timeout from {@link EthRpcOptions}.
 *
 * @param options - Timeout override from the caller.
 * @returns Positive timeout in milliseconds.
 */
function defaultTimeoutMs(options: EthRpcOptions): number {
  if (options.timeoutMs != null && options.timeoutMs > 0) {
    return options.timeoutMs;
  }
  return 5000;
}

/**
 * POST one JSON-RPC 2.0 request and return the `result` field.
 *
 * @param rpcUrl - Fully resolved HTTP endpoint.
 * @param method - JSON-RPC method name (e.g. `eth_call`).
 * @param params - JSON-RPC params array.
 * @param options - Request timeout; see {@link EthRpcOptions.timeoutMs}.
 * @returns Parsed `result` from a successful response.
 * @throws When HTTP fails, the node returns a JSON-RPC error, or the request
 *   times out.
 */
export async function ethRpc(
  rpcUrl: string,
  method: string,
  params: unknown[],
  options: EthRpcOptions = {},
): Promise<unknown> {
  const timeoutMs = defaultTimeoutMs(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
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
  } catch (error) {
    // fetch abort surfaces as AbortError; map to an operator-friendly message.
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`RPC ${method} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try RPC URLs in preference order; fail only when every endpoint fails.
 *
 * @param rpcUrls - Preference-ordered endpoints for one chain binding.
 * @param method - JSON-RPC method name.
 * @param params - JSON-RPC params array.
 * @param options - Per-request timeout passed to each attempt.
 * @returns Result from the first successful endpoint.
 * @throws When no URLs are configured or every endpoint fails.
 */
export async function ethRpcWithFailover(
  rpcUrls: string[],
  method: string,
  params: unknown[],
  options: EthRpcOptions = {},
): Promise<unknown> {
  if (rpcUrls.length === 0) {
    throw new Error("No RPC URLs configured");
  }

  const errors: string[] = [];
  for (const url of rpcUrls) {
    try {
      return await ethRpc(url, method, params, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${url}: ${message}`);
    }
  }

  throw new Error(
    `All RPC endpoints failed for ${method}: ${errors.join("; ")}`,
  );
}

/**
 * `eth_call` against `latest` block for contract view reads.
 *
 * @param rpcUrl - Target JSON-RPC endpoint.
 * @param to - Contract address (checksummed or lowercase hex).
 * @param data - ABI-encoded calldata hex.
 * @param options - Per-request timeout.
 * @returns Opaque RPC result (typically hex string).
 */
export async function ethCall(
  rpcUrl: string,
  to: string,
  data: string,
  options: EthRpcOptions = {},
): Promise<unknown> {
  return ethRpc(rpcUrl, "eth_call", [{ to, data }, "latest"], options);
}

/**
 * Failover wrapper for {@link ethCall}.
 *
 * @param rpcUrls - Preference-ordered endpoints for one chain.
 * @param to - Contract address.
 * @param data - ABI-encoded calldata hex.
 * @param options - Per-request timeout passed to each attempt.
 */
export async function ethCallWithFailover(
  rpcUrls: string[],
  to: string,
  data: string,
  options: EthRpcOptions = {},
): Promise<unknown> {
  return ethRpcWithFailover(
    rpcUrls,
    "eth_call",
    [{ to, data }, "latest"],
    options,
  );
}

/**
 * Normalize a hex address to 40 lowercase nibbles without `0x`.
 *
 * @param addr - User-supplied address string.
 * @returns Lowercase 40-char hex or `null` when invalid.
 */
export function normalizeHexAddress(addr: string): string | null {
  const trimmed = addr.trim().toLowerCase();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-f]{40}$/.test(hex)) return null;
  return hex;
}

/**
 * Whether bytecode is deployed at an address (non-empty, non-zero code).
 * Used before ERC-1271 KS256 verification to distinguish contract from EOA
 * roots.
 *
 * @param rpcUrls - One URL or preference-ordered list for the binding chain.
 * @param addressHex - 40-char hex without `0x` prefix.
 * @param options - Per-request timeout for `eth_getCode`.
 */
export async function hasContractCodeAt(
  rpcUrls: string | string[],
  addressHex: string,
  options: EthRpcOptions = {},
): Promise<boolean> {
  const urls = Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls];
  const result = (await ethRpcWithFailover(
    urls,
    "eth_getCode",
    [`0x${addressHex}`, "latest"],
    options,
  )) as string;
  if (typeof result !== "string") return false;
  const stripped = result.replace(/^0x/i, "");
  return stripped.length > 0 && !/^0+$/.test(stripped);
}

/**
 * Decode a 40-char hex address to 20 bytes for COSE kid / Web Crypto interop.
 *
 * @param hex40 - Lowercase hex without `0x`; caller must validate length.
 */
export function hexAddressToBytes(hex40: string): Uint8Array {
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    out[i] = Number.parseInt(hex40.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Encode bytes as lowercase hex without `0x` (RPC calldata building).
 *
 * @param bytes - Raw bytes to encode.
 */
function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export { bytesToHex };
