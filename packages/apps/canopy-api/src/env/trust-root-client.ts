/**
 * Trust-root client seam: read-only expected log signing key for delegation verify.
 */

import {
  fetchCustodianPublicKey,
  importSpkiPemVerifyKeyWithAlg,
} from "../scrapi/custodian-grant.js";
import type { ParsedVerifyKey } from "@canopy/encoding";

/** Last-resort trust root when curator lacks an index but Ranger still uses legacy key. */
const CUSTODIAN_LEGACY_SIGNING_KEY_PUBLIC_SEGMENT = ":bootstrap";

export interface TrustRootClient {
  logSigningKey(ownerLogIdLowerHex32: string): Promise<ParsedVerifyKey>;
}

export function createCustodianPublicTrustRootClient(config: {
  custodianBaseUrl: string;
}): TrustRootClient {
  const base = config.custodianBaseUrl.trim().replace(/\/$/, "");
  const cache = new Map<string, Promise<ParsedVerifyKey>>();

  return {
    async logSigningKey(
      ownerLogIdLowerHex32: string,
    ): Promise<ParsedVerifyKey> {
      let p = cache.get(ownerLogIdLowerHex32);
      if (!p) {
        p = (async (): Promise<ParsedVerifyKey> => {
          try {
            const { publicKeyPem, alg } = await fetchCustodianPublicKey(
              base,
              ownerLogIdLowerHex32,
              { logId: true },
            );
            return importSpkiPemVerifyKeyWithAlg(publicKeyPem, alg);
          } catch {
            // continue
          }

          const { publicKeyPem, alg } = await fetchCustodianPublicKey(
            base,
            CUSTODIAN_LEGACY_SIGNING_KEY_PUBLIC_SEGMENT,
          );
          return importSpkiPemVerifyKeyWithAlg(publicKeyPem, alg);
        })();

        p = p.catch((err: unknown) => {
          cache.delete(ownerLogIdLowerHex32);
          throw err;
        });
        cache.set(ownerLogIdLowerHex32, p);
      }
      return p;
    },
  };
}
