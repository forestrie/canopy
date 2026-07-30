/**
 * Shared ERC-1271 verify-hooks factory for KS256 contract-account roots
 * (plan-2607-45 Safe 1x1 Mode D). One implementation of the
 * `eth_getCode` / `isValidSignature` pair for every KS256 verifier — the
 * grant path, the onboarding/account-read CWT verifier, and the
 * delegation-coordinator all consume this instead of keeping copies.
 *
 * Hooks PROPAGATE RPC errors: a caller that must fail closed (never fall
 * back to ecrecover for an address that may hold code) catches and rejects;
 * a caller that prefers to swallow wraps the hook itself.
 */

import {
  bytesToHex,
  ethCallWithFailover,
  ethRpc,
  hasContractCodeAt,
} from "./eth-rpc.js";
import type { EthRpcOptions } from "./eth-rpc.js";

/**
 * Every RPC endpoint failed while resolving an ERC-1271 question. Callers
 * fail closed on this, but SHOULD surface it as an availability outcome
 * (503-shaped), not a verification verdict — "could not ask the contract"
 * is not "the contract said no".
 */
export class Erc1271UnavailableError extends Error {
  constructor(operation: string, cause: unknown) {
    super(
      `ERC-1271 ${operation} unavailable: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "Erc1271UnavailableError";
  }
}

/** `isValidSignature(bytes32,bytes)` selector. */
const ERC1271_SELECTOR = "1626ba7e";

/** Magic value (the selector, as bytes4) a valid signature check returns. */
const ERC1271_MAGIC = "0x1626ba7e";

/**
 * ERC-1271 verification hooks. Structurally identical to
 * `Ks256VerifyHooks` in `@forestrie/delegation-cose` — kept nominal-free
 * here so this package stays dependency-less.
 */
export interface Erc1271VerifyHooks {
  /**
   * @param address - 20-byte account address.
   * @returns `true` when the address has deployed contract code.
   * @throws When every RPC endpoint fails.
   */
  hasContractCode(address: Uint8Array): Promise<boolean>;
  /**
   * ERC-1271 `isValidSignature` check for contract accounts.
   *
   * @param address - Contract address that must validate the signature.
   * @param hash - 32-byte digest (keccak256 of Sig_structure for KS256).
   * @param signature - Signature bytes from the COSE envelope; contract
   *   signatures are NOT length-restricted (a Safe owner signature is not
   *   the 65-byte EOA blob).
   * @throws When every RPC endpoint fails.
   */
  isValidSignature(
    address: Uint8Array,
    hash: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean>;
}

/**
 * ABI-encode an `isValidSignature(bytes32,bytes)` call without an ABI
 * library: selector ‖ hash ‖ offset(0x40) ‖ length ‖ right-padded bytes.
 *
 * @param hash - 32-byte digest.
 * @param signature - Arbitrary-length signature bytes.
 */
export function encodeIsValidSignatureCall(
  hash: Uint8Array,
  signature: Uint8Array,
): string {
  if (hash.length !== 32) {
    throw new Error("ERC-1271 hash must be 32 bytes");
  }
  const word = (n: number) => n.toString(16).padStart(64, "0");
  const sigPadded = bytesToHex(signature).padEnd(
    Math.ceil(signature.length / 32) * 64,
    "0",
  );
  return `0x${ERC1271_SELECTOR}${bytesToHex(hash)}${word(0x40)}${word(signature.length)}${sigPadded}`;
}

/** Options for {@link createErc1271VerifyHooks}. */
export interface Erc1271VerifyHooksOptions extends EthRpcOptions {
  /**
   * Decimal EIP-155 chain id the endpoints MUST serve (plan-2607-46 slice
   * 03). When set, each endpoint's `eth_chainId` is probed lazily on first
   * use (memoized per isolate) and endpoints that disagree are refused; if
   * no endpoint matches, hooks throw {@link Erc1271UnavailableError} — a
   * wrong-chain RPC is a misconfiguration, never a verification verdict.
   */
  expectedChainId?: string;
}

/** Per-isolate memo of each endpoint's answered chain id. */
const endpointChainIds = new Map<string, Promise<number>>();

function probeEndpointChainId(
  url: string,
  options: EthRpcOptions,
): Promise<number> {
  let pending = endpointChainIds.get(url);
  if (!pending) {
    pending = ethRpc(url, "eth_chainId", [], options).then((result) => {
      const parsed =
        typeof result === "string" ? Number.parseInt(result, 16) : Number.NaN;
      if (!Number.isSafeInteger(parsed)) {
        throw new Error(`eth_chainId returned invalid data from ${url}`);
      }
      return parsed;
    });
    // Do not memoize failures — a transient outage must not poison the URL.
    pending.catch(() => endpointChainIds.delete(url));
    endpointChainIds.set(url, pending);
  }
  return pending;
}

/**
 * Build ERC-1271 hooks over JSON-RPC with failover.
 *
 * The magic-value check accepts the returned word by PREFIX: `eth_call`
 * returns the `bytes4` ABI-encoded as a right-zero-padded 32-byte word, so
 * strict equality against `0x1626ba7e` would reject every genuine
 * contract signature.
 *
 * @param rpcUrls - Preference-ordered endpoints for the binding chain.
 * @param options - Per-request timeout and optional expected chain id.
 */
export function createErc1271VerifyHooks(
  rpcUrls: string[],
  options: Erc1271VerifyHooksOptions = {},
): Erc1271VerifyHooks {
  const { expectedChainId, ...rpcOptions } = options;

  let asserted: Promise<string[]> | undefined;
  function urlsForCalls(): Promise<string[]> {
    if (!expectedChainId) return Promise.resolve(rpcUrls);
    if (!asserted) {
      asserted = (async () => {
        const expected = Number.parseInt(expectedChainId, 10);
        const matching: string[] = [];
        const reasons: string[] = [];
        for (const url of rpcUrls) {
          try {
            const got = await probeEndpointChainId(url, rpcOptions);
            if (got === expected) {
              matching.push(url);
            } else {
              reasons.push(`${url}: serves chain ${got}, expected ${expected}`);
            }
          } catch (error) {
            reasons.push(
              `${url}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (matching.length === 0) {
          throw new Erc1271UnavailableError(
            "eth_chainId",
            new Error(reasons.join("; ") || "no endpoints configured"),
          );
        }
        return matching;
      })();
      // A failed assertion must retry on the next call, not stick.
      asserted.catch(() => {
        asserted = undefined;
      });
    }
    return asserted;
  }

  return {
    async hasContractCode(address: Uint8Array): Promise<boolean> {
      const urls = await urlsForCalls();
      try {
        return await hasContractCodeAt(urls, bytesToHex(address), rpcOptions);
      } catch (error) {
        throw new Erc1271UnavailableError("eth_getCode", error);
      }
    },
    async isValidSignature(
      address: Uint8Array,
      hash: Uint8Array,
      signature: Uint8Array,
    ): Promise<boolean> {
      // Encoding failures (bad hash length) are caller bugs, not
      // availability — keep them outside the unavailable wrapping.
      const data = encodeIsValidSignatureCall(hash, signature);
      const urls = await urlsForCalls();
      let result: unknown;
      try {
        result = await ethCallWithFailover(
          urls,
          `0x${bytesToHex(address)}`,
          data,
          rpcOptions,
        );
      } catch (error) {
        throw new Erc1271UnavailableError("isValidSignature eth_call", error);
      }
      return (
        typeof result === "string" &&
        result.toLowerCase().startsWith(ERC1271_MAGIC)
      );
    },
  };
}
