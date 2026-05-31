/**
 * Receipt authority resolver: trust root + local delegation verification.
 */

import type { ParsedVerifyKey } from "@canopy/encoding";
import { resolveReceiptVerifyKey } from "../grant/delegation-verify.js";
import { isCanopyApiPoolTestMode } from "./runtime-mode.js";
import {
  createCoordinatorPublicTrustRootClient,
  createCustodianPublicTrustRootClient,
  isTrustRootNotFound,
  type TrustRootClient,
} from "./trust-root-client.js";
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

export type ReceiptAuthorityResolver = (
  ownerLogIdLowerHex32: string,
  receiptCoseBytes: Uint8Array,
) => Promise<ParsedVerifyKey[] | null>;

/**
 * Resolve verify-key candidates from each trust-root client. When coordinator
 * public-root differs from Custodian curator signing (dev custodial forests),
 * merging keys lets receipt signature verify against the key that actually
 * sealed the peak.
 */
export async function resolveReceiptVerifyKeysFromTrustRoots(
  ownerLogIdLowerHex32: string,
  receiptCoseBytes: Uint8Array,
  trustRootClients: TrustRootClient[],
): Promise<ParsedVerifyKey[] | null> {
  const merged: ParsedVerifyKey[] = [];
  for (const client of trustRootClients) {
    let trustRoot: ParsedVerifyKey;
    try {
      trustRoot = await client.logSigningKey(ownerLogIdLowerHex32);
    } catch (error) {
      if (isTrustRootNotFound(error)) continue;
      throw error;
    }
    const resolved = await resolveReceiptVerifyKey(receiptCoseBytes, trustRoot);
    if (resolved?.verifyKeys?.length) {
      merged.push(...resolved.verifyKeys);
    }
  }
  return merged.length > 0 ? merged : null;
}

export function createReceiptAuthorityResolver(config: {
  trustRootUrl: string;
  coordinatorTrustRootUrl?: string;
  coordinatorToken?: string;
  nodeEnv: string;
  testReceiptVerifyEs256XyHex?: string;
}): ReceiptAuthorityResolver {
  const pool = isCanopyApiPoolTestMode({ NODE_ENV: config.nodeEnv });
  const testHex = config.testReceiptVerifyEs256XyHex?.trim();

  let trustRootClients: TrustRootClient[];
  if (pool && testHex) {
    const xy = hexToBytes32Pair(testHex);
    const keyPromise = importEs256PublicKeyFromGrantDataXy64(xy);
    trustRootClients = [
      {
        logSigningKey: async () => keyPromise,
      },
    ];
  } else {
    const custodian = createCustodianPublicTrustRootClient({
      custodianBaseUrl: config.trustRootUrl,
    });
    const coordinatorUrl = config.coordinatorTrustRootUrl?.trim();
    const coordinatorToken = config.coordinatorToken?.trim();
    if (coordinatorUrl && coordinatorToken) {
      trustRootClients = [
        createCoordinatorPublicTrustRootClient({
          coordinatorBaseUrl: coordinatorUrl,
          token: coordinatorToken,
        }),
        custodian,
      ];
    } else {
      trustRootClients = [custodian];
    }
  }

  const cache = new Map<string, Promise<ParsedVerifyKey[] | null>>();

  return async (
    ownerLogIdLowerHex32: string,
    receiptCoseBytes: Uint8Array,
  ): Promise<ParsedVerifyKey[] | null> => {
    const receiptSuffix = await receiptResolverCacheKeySuffix(receiptCoseBytes);
    const cacheKey = `${ownerLogIdLowerHex32}\0${receiptSuffix}`;
    let p = cache.get(cacheKey);
    if (!p) {
      p = resolveReceiptVerifyKeysFromTrustRoots(
        ownerLogIdLowerHex32,
        receiptCoseBytes,
        trustRootClients,
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
