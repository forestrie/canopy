/**
 * Trust-root client seam: read-only expected log signing key for delegation verify.
 */

import {
  fetchCustodianPublicKey,
  importEs256PublicKeyFromGrantDataXy64,
  importSpkiPemVerifyKeyWithAlg,
} from "../scrapi/custodian-grant.js";
import type { ParsedVerifyKey } from "@canopy/encoding";
import { decode } from "cbor-x";

export interface TrustRootClient {
  logSigningKey(ownerLogIdLowerHex32: string): Promise<ParsedVerifyKey>;
}

class TrustRootNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustRootNotFoundError";
  }
}

export function isTrustRootNotFound(error: unknown): boolean {
  return error instanceof TrustRootNotFoundError;
}

interface CborTrustRootResponse {
  logId: Uint8Array;
  alg: string;
  x: Uint8Array;
  y: Uint8Array;
}

/**
 * Generic CBOR public-root client: `GET {base}/api/logs/{id}/public-root` with a
 * Bearer token, decoding the `{ logId, alg, x, y }` CBOR `TrustRootResponse`.
 * Shared by the coordinator and univocity authority resolvers (same wire shape).
 */
function createBearerCborTrustRootClient(config: {
  baseUrl: string;
  token: string;
  label: string;
}): TrustRootClient {
  const base = config.baseUrl.trim().replace(/\/$/, "");
  const token = config.token.trim();
  const { label } = config;
  const cache = new Map<string, Promise<ParsedVerifyKey>>();

  return {
    async logSigningKey(
      ownerLogIdLowerHex32: string,
    ): Promise<ParsedVerifyKey> {
      let p = cache.get(ownerLogIdLowerHex32);
      if (!p) {
        p = (async (): Promise<ParsedVerifyKey> => {
          if (!base) throw new Error(`${label} trust-root URL is empty`);
          if (!token) throw new Error(`${label} trust-root token is empty`);

          const resp = await fetch(
            `${base}/api/logs/${ownerLogIdLowerHex32}/public-root`,
            {
              method: "GET",
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/cbor",
              },
            },
          );
          const body = new Uint8Array(await resp.arrayBuffer());
          if (resp.status === 404) {
            throw new TrustRootNotFoundError(`${label} public root missing`);
          }
          if (!resp.ok) {
            throw new Error(
              `${label} public root returned ${resp.status} (${body.byteLength} bytes)`,
            );
          }

          const decoded = decode(body) as CborTrustRootResponse;
          if (decoded.alg !== "ES256") {
            throw new Error(
              `unsupported ${label} trust-root alg ${decoded.alg}`,
            );
          }
          if (
            !(decoded.x instanceof Uint8Array) ||
            decoded.x.byteLength !== 32 ||
            !(decoded.y instanceof Uint8Array) ||
            decoded.y.byteLength !== 32
          ) {
            throw new Error(`${label} trust-root x/y must be 32 bytes each`);
          }
          const xy = new Uint8Array(64);
          xy.set(decoded.x, 0);
          xy.set(decoded.y, 32);
          return importEs256PublicKeyFromGrantDataXy64(xy);
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

export function createCoordinatorPublicTrustRootClient(config: {
  coordinatorBaseUrl: string;
  token: string;
}): TrustRootClient {
  return createBearerCborTrustRootClient({
    baseUrl: config.coordinatorBaseUrl,
    token: config.token,
    label: "coordinator",
  });
}

/**
 * Univocity authority resolver client: reads the chain/grant-derived public root
 * from the univocity owned store (`GET /api/logs/{id}/public-root`). Same anchor
 * the sealer authorizes against (plan-0029).
 */
export function createUnivocityPublicTrustRootClient(config: {
  univocityBaseUrl: string;
  token: string;
}): TrustRootClient {
  return createBearerCborTrustRootClient({
    baseUrl: config.univocityBaseUrl,
    token: config.token,
    label: "univocity",
  });
}

export function createSelectingTrustRootClient(config: {
  primary: TrustRootClient;
  fallback: TrustRootClient;
}): TrustRootClient {
  return {
    async logSigningKey(
      ownerLogIdLowerHex32: string,
    ): Promise<ParsedVerifyKey> {
      try {
        return await config.primary.logSigningKey(ownerLogIdLowerHex32);
      } catch (error) {
        if (!isTrustRootNotFound(error)) throw error;
      }
      return config.fallback.logSigningKey(ownerLogIdLowerHex32);
    },
  };
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
          // `?log-id=true` lets the Custodian resolve the per-log custody key, or
          // its :bootstrap key server-side when this log is the configured root.
          // There is no client-side :bootstrap fallback: a 404 means the Custodian
          // has no trust root for this log (callers may try other roots), and any
          // other failure is surfaced so a broken per-log lookup cannot be silently
          // masked by signing-key substitution.
          let publicKeyPem: string;
          let alg: string;
          try {
            ({ publicKeyPem, alg } = await fetchCustodianPublicKey(
              base,
              ownerLogIdLowerHex32,
              { logId: true },
            ));
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (/public key fetch failed: 404\b/.test(message)) {
              throw new TrustRootNotFoundError(
                `custodian has no signing key for log ${ownerLogIdLowerHex32}`,
              );
            }
            throw error;
          }
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
