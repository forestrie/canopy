/**
 * Receipt authority resolver: trust root + local delegation verification.
 */

import type { ParsedVerifyKey } from "@canopy/encoding";
import { resolveReceiptVerifyKey } from "../grant/delegation-verify.js";
import { isCanopyApiPoolTestMode } from "./runtime-mode.js";
import {
  createCustodianPublicTrustRootClient,
  type TrustRootClient,
} from "./trust-root-client.js";
import { importEs256PublicKeyFromGrantDataXy64 } from "../scrapi/custodian-grant.js";

const MAX_OWNER_LOG_CACHE = 64;

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

export function createReceiptAuthorityResolver(config: {
  trustRootUrl: string;
  nodeEnv: string;
  testReceiptVerifyEs256XyHex?: string;
}): ReceiptAuthorityResolver {
  const pool = isCanopyApiPoolTestMode({ NODE_ENV: config.nodeEnv });
  const testHex = config.testReceiptVerifyEs256XyHex?.trim();

  let trustRootClient: TrustRootClient;
  if (pool && testHex) {
    const xy = hexToBytes32Pair(testHex);
    const keyPromise = importEs256PublicKeyFromGrantDataXy64(xy);
    trustRootClient = {
      logSigningKey: async () => keyPromise,
    };
  } else {
    trustRootClient = createCustodianPublicTrustRootClient({
      custodianBaseUrl: config.trustRootUrl,
    });
  }

  const cache = new Map<string, Promise<ParsedVerifyKey[] | null>>();

  return async (
    ownerLogIdLowerHex32: string,
    receiptCoseBytes: Uint8Array,
  ): Promise<ParsedVerifyKey[] | null> => {
    const cacheKey = `${ownerLogIdLowerHex32}\0${receiptCoseBytes.byteLength}`;
    let p = cache.get(cacheKey);
    if (!p) {
      p = (async (): Promise<ParsedVerifyKey[] | null> => {
        const trustRoot =
          await trustRootClient.logSigningKey(ownerLogIdLowerHex32);
        const resolved = await resolveReceiptVerifyKey(
          receiptCoseBytes,
          trustRoot,
        );
        return resolved?.verifyKeys ?? null;
      })();

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
