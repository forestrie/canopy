/**
 * Trust-root client seam: read-only expected log signing key for delegation verify.
 */

import {
  logIdToStorageSegment,
  parseLogIdSegment,
} from "../grant/log-id-wire.js";
import {
  fetchCustodianPublicKey,
  importSpkiPemVerifyKeyWithAlg,
} from "../scrapi/custodian-grant.js";
import { decodeCborDeterministic } from "@forestrie/encoding";
import {
  decodeTrustRootCbor,
  type RootVerifyKey,
} from "./decode-trust-root-cbor.js";

export type { RootVerifyKey } from "./decode-trust-root-cbor.js";

export interface TrustRootClient {
  logSigningKey(ownerLogIdLowerHex32: string): Promise<RootVerifyKey>;
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

/** Canonical dashed UUID for univocity/coordinator `/api/logs/{id}/…` paths. */
function ownerLogIdToApiSegment(ownerLogIdLowerHex32: string): string {
  return logIdToStorageSegment(parseLogIdSegment(ownerLogIdLowerHex32));
}

function createBearerCborTrustRootClient(config: {
  baseUrl: string;
  token: string;
  label: string;
}): TrustRootClient {
  const base = config.baseUrl.trim().replace(/\/$/, "");
  const token = config.token.trim();
  const { label } = config;
  const cache = new Map<string, Promise<RootVerifyKey>>();

  return {
    async logSigningKey(ownerLogIdLowerHex32: string): Promise<RootVerifyKey> {
      let p = cache.get(ownerLogIdLowerHex32);
      if (!p) {
        p = (async (): Promise<RootVerifyKey> => {
          if (!base) throw new Error(`${label} trust-root URL is empty`);
          if (!token) throw new Error(`${label} trust-root token is empty`);

          const apiLogId = ownerLogIdToApiSegment(ownerLogIdLowerHex32);
          const resp = await fetch(`${base}/api/logs/${apiLogId}/public-root`, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/cbor",
            },
          });
          const body = new Uint8Array(await resp.arrayBuffer());
          if (resp.status === 404) {
            throw new TrustRootNotFoundError(`${label} public root missing`);
          }
          if (!resp.ok) {
            throw new Error(
              `${label} public root returned ${resp.status} (${body.byteLength} bytes)`,
            );
          }

          const decoded = decodeCborDeterministic(body);
          try {
            return await decodeTrustRootCbor(decoded);
          } catch (e) {
            throw new Error(
              `${label} trust-root decode failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
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
    async logSigningKey(ownerLogIdLowerHex32: string): Promise<RootVerifyKey> {
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
  const cache = new Map<string, Promise<RootVerifyKey>>();

  return {
    async logSigningKey(ownerLogIdLowerHex32: string): Promise<RootVerifyKey> {
      let p = cache.get(ownerLogIdLowerHex32);
      if (!p) {
        p = (async (): Promise<RootVerifyKey> => {
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
