/**
 * Receipt authority resolver: a log's trust root, from univocity only, plus
 * local delegation verification. An unavailable or pending root is transient
 * ({@link TrustRootUnresolvedError}); a conflicted log verifies nothing.
 */

import type { ParsedVerifyKey } from "@forestrie/encoding";
import {
  rpcUrlsForChainId,
  type SupportedChainsConfig,
} from "@forestrie/chain-rpc";
import { resolveReceiptVerifyKey } from "../grant/delegation-verify.js";
import { isCanopyApiPoolTestMode } from "./runtime-mode.js";
import {
  createUnivocityTrustRootClient,
  isTrustRootNotFound,
  TrustRootConflictedError,
  type RootVerifyKey,
  type TrustRootClient,
} from "./trust-root-client.js";
import type { LogAuthorityReader } from "./log-authority-reader.js";
import { importEs256PublicKeyFromGrantDataXy64 } from "../scrapi/custodian-grant.js";

const MAX_OWNER_LOG_CACHE = 64;

/** Cache key suffix: first 16 bytes of SHA-256(receipt) so distinct receipts are not conflated. */
export async function receiptResolverCacheKeySuffix(
  receiptCoseBytes: Uint8Array,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", receiptCoseBytes);
  const u8 = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += u8[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

function hexToBytes32Pair(hex: string): Uint8Array {
  const s = hex.replace(/^0x/i, "").trim();
  if (s.length !== 128 || !/^[0-9a-fA-F]+$/.test(s)) {
    throw new Error(
      "FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX must be 128 hex chars (64-byte x||y)",
    );
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Verify keys for receipt Sign1 (ES256 CryptoKey / parsed EC2 or KS256 root address). */
export type ReceiptVerifyKey = RootVerifyKey;

/**
 * Raised when NO trust root could be resolved for a log — every client reported
 * the log's public root as not-found (FOR-302, ADR-0057 §5).
 *
 * This is deliberately distinct from a normal negative result (a trust root was
 * found, but the receipt did not verify against it), which stays a plain `null`.
 * "No root anywhere" is not a statement that the receipt is invalid: the caller
 * simply could not obtain the material to check it, exactly like a transport
 * failure. A BYOK root registered moments ago is indistinguishable from one that
 * never existed, so the answer is transient — callers map it to 503 (retryable),
 * not 403 (terminal). Because it is thrown rather than returned, the resolver
 * cache does not memoise it, so a retry after propagation re-checks.
 */
export class TrustRootUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustRootUnresolvedError";
  }
}

export function isTrustRootUnresolved(error: unknown): boolean {
  return error instanceof TrustRootUnresolvedError;
}

export type ReceiptAuthorityResolver = (
  ownerLogIdLowerHex32: string,
  receiptCoseBytes: Uint8Array,
  ks256ChainId?: string,
) => Promise<ReceiptVerifyKey[] | null>;

/**
 * Resolve verify-key candidates from each trust-root client, merging the keys
 * every client yields. Production has one client (univocity); tests may pass
 * several. A conflicted log ({@link TrustRootConflictedError}) verifies
 * nothing, so it is the terminal negative `null`.
 */
export async function resolveReceiptVerifyKeysFromTrustRoots(
  ownerLogIdLowerHex32: string,
  receiptCoseBytes: Uint8Array,
  trustRootClients: TrustRootClient[],
  opts?: { rpcUrls?: string[] },
): Promise<ReceiptVerifyKey[] | null> {
  const merged: ReceiptVerifyKey[] = [];
  let sawTrustRoot = false;
  for (const client of trustRootClients) {
    let trustRoot: RootVerifyKey;
    try {
      trustRoot = await client.logSigningKey(ownerLogIdLowerHex32);
    } catch (error) {
      if (isTrustRootNotFound(error)) continue;
      if (error instanceof TrustRootConflictedError) return null;
      throw error;
    }
    sawTrustRoot = true;
    const resolved = await resolveReceiptVerifyKey(
      receiptCoseBytes,
      trustRoot,
      opts,
    );
    if (resolved?.verifyKeys?.length) {
      merged.push(...resolved.verifyKeys);
    }
  }
  if (merged.length > 0) return merged;
  if (!sawTrustRoot) {
    // Nothing found the log's root — transient, retryable (see
    // TrustRootUnresolvedError). Distinct from the return below.
    throw new TrustRootUnresolvedError(
      `no trust root resolved for log ${ownerLogIdLowerHex32}`,
    );
  }
  // A trust root WAS found; the receipt just did not verify against it. That is
  // a normal, terminal negative — never retryable.
  return null;
}

/**
 * Builds the resolver canopy-api verifies receipts with.
 *
 * @param config.logAuthority univocity's log authority, the only source of
 *   root keys. Without it, no log has a trust root (retryable).
 * @param config.testReceiptVerifyEs256XyHex pool-test mode only: a fixed
 *   ES256 root in place of univocity.
 */
export function createReceiptAuthorityResolver(config: {
  logAuthority?: LogAuthorityReader;
  nodeEnv: string;
  testReceiptVerifyEs256XyHex?: string;
  /** chainId → preference-ordered RPC URLs for KS256 ERC-1271 verify. */
  supportedChains?: SupportedChainsConfig | null;
}): ReceiptAuthorityResolver {
  const pool = isCanopyApiPoolTestMode({ NODE_ENV: config.nodeEnv });
  const testHex = config.testReceiptVerifyEs256XyHex?.trim();
  const supportedChains = config.supportedChains ?? null;

  let trustRootClients: TrustRootClient[];
  if (pool && testHex) {
    const xy = hexToBytes32Pair(testHex);
    const keyPromise = importEs256PublicKeyFromGrantDataXy64(xy);
    trustRootClients = [
      {
        logSigningKey: async (): Promise<ParsedVerifyKey> => keyPromise,
      },
    ];
  } else {
    trustRootClients = config.logAuthority
      ? [createUnivocityTrustRootClient(config.logAuthority)]
      : [];
  }

  const cache = new Map<string, Promise<ReceiptVerifyKey[] | null>>();

  return async (
    ownerLogIdLowerHex32: string,
    receiptCoseBytes: Uint8Array,
    ks256ChainId?: string,
  ): Promise<ReceiptVerifyKey[] | null> => {
    const receiptSuffix = await receiptResolverCacheKeySuffix(receiptCoseBytes);
    const chainSuffix = ks256ChainId?.trim() ?? "";
    const cacheKey = `${ownerLogIdLowerHex32}\0${receiptSuffix}\0${chainSuffix}`;
    let p = cache.get(cacheKey);
    if (!p) {
      const rpcUrls =
        chainSuffix && supportedChains
          ? (rpcUrlsForChainId(supportedChains, chainSuffix) ?? undefined)
          : undefined;
      p = resolveReceiptVerifyKeysFromTrustRoots(
        ownerLogIdLowerHex32,
        receiptCoseBytes,
        trustRootClients,
        rpcUrls?.length ? { rpcUrls } : undefined,
      );

      p = p.catch((err: unknown) => {
        cache.delete(cacheKey);
        throw err;
      });

      if (cache.size >= MAX_OWNER_LOG_CACHE) {
        cache.clear();
      }
      cache.set(cacheKey, p);
    }
    return p;
  };
}
