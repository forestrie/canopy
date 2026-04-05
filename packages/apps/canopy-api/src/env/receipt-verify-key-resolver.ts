/**
 * Resolves the ES256 public key used to verify SCITT receipt COSE Sign1 for a log,
 * via Custodian (curator/log-key + public) or a test-only fixed x‖y when pool mode.
 */

import {
  CUSTODIAN_BOOTSTRAP_KEY_ID,
  fetchCustodianCuratorLogKey,
  fetchCustodianPublicKey,
  importEs256PublicKeyFromGrantDataXy64,
  importSpkiPemEs256VerifyKey,
} from "../scrapi/custodian-grant.js";
import { isCanopyApiPoolTestMode } from "./runtime-mode.js";

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

/** @param ownerLogIdLowerHex32 — 32-char lowercase hex for the semantic 16-byte log id. */
export type ReceiptVerifyKeyResolver = (
  ownerLogIdLowerHex32: string,
) => Promise<CryptoKey>;

/**
 * Production / dev: fetches Custodian key id per owner log id (hex), then SPKI PEM → verify key.
 * Pool test with `testReceiptVerifyEs256XyHex`: static ES256 x‖y (no Custodian).
 */
export function createReceiptVerifyKeyResolver(config: {
  custodianBaseUrl: string;
  custodianAppToken: string;
  nodeEnv: string;
  testReceiptVerifyEs256XyHex?: string;
}): ReceiptVerifyKeyResolver {
  const pool = isCanopyApiPoolTestMode({ NODE_ENV: config.nodeEnv });
  const testHex = config.testReceiptVerifyEs256XyHex?.trim();

  if (pool && testHex) {
    const xy = hexToBytes32Pair(testHex);
    const keyPromise = importEs256PublicKeyFromGrantDataXy64(xy);
    return async () => keyPromise;
  }

  const base = config.custodianBaseUrl.trim().replace(/\/$/, "");
  const token = config.custodianAppToken.trim();
  const cache = new Map<string, Promise<CryptoKey>>();

  return async (ownerLogIdLowerHex32: string) => {
    let p = cache.get(ownerLogIdLowerHex32);
    if (!p) {
      p = (async () => {
        try {
          const keyId = await fetchCustodianCuratorLogKey(
            base,
            token,
            ownerLogIdLowerHex32,
          );
          const { publicKeyPem } = await fetchCustodianPublicKey(base, keyId);
          return importSpkiPemEs256VerifyKey(publicKeyPem);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const missingLogKey =
            /\b404\b/.test(msg) ||
            /not\s*found/i.test(msg) ||
            /\bno\s+key\b/i.test(msg);
          if (!missingLogKey) throw e;
          const { publicKeyPem } = await fetchCustodianPublicKey(
            base,
            CUSTODIAN_BOOTSTRAP_KEY_ID,
          );
          return importSpkiPemEs256VerifyKey(publicKeyPem);
        }
      })();
      if (cache.size >= MAX_OWNER_LOG_CACHE) {
        cache.clear();
      }
      cache.set(ownerLogIdLowerHex32, p);
    }
    return p;
  };
}
