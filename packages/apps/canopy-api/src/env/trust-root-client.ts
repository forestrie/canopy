/**
 * Trust-root client seam: read-only expected log signing key for receipt and
 * delegation verification.
 */

import { parseLogIdSegment } from "../grant/log-id-wire.js";
import {
  decodeTrustRootCbor,
  type RootVerifyKey,
} from "./decode-trust-root-cbor.js";
import type { LogAuthorityReader } from "./log-authority-reader.js";

export type { RootVerifyKey } from "./decode-trust-root-cbor.js";

export interface TrustRootClient {
  logSigningKey(ownerLogIdLowerHex32: string): Promise<RootVerifyKey>;
}

export class TrustRootNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustRootNotFoundError";
  }
}

export function isTrustRootNotFound(error: unknown): boolean {
  return error instanceof TrustRootNotFoundError;
}

/**
 * Raised for a log whose authority is conflicted: a trust root exists, but
 * nothing may be verified under it (protocol ADR-0070). Distinct from
 * {@link TrustRootNotFoundError}, which is transient.
 */
export class TrustRootConflictedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustRootConflictedError";
  }
}

/**
 * The only trust-root client: a log's root key from univocity's authority
 * answer, used only once anchored
 * ([devdocs ADR-0075](https://github.com/forestrie/devdocs/blob/main/adr/adr-0075-sec-child-root-claimed-once.md)
 * decision 5). Pending, unclaimed and unavailable logs have no trust root
 * yet ({@link TrustRootNotFoundError}); a conflicted log raises
 * {@link TrustRootConflictedError}. Custodian and the delegation coordinator
 * are not sources of root keys.
 */
export function createUnivocityTrustRootClient(
  reader: LogAuthorityReader,
): TrustRootClient {
  return {
    async logSigningKey(ownerLogIdLowerHex32: string): Promise<RootVerifyKey> {
      const authority = await reader.read(
        parseLogIdSegment(ownerLogIdLowerHex32),
      );
      switch (authority.kind) {
        case "anchored":
          return decodeTrustRootCbor({
            alg: authority.alg,
            key: authority.key,
          });
        case "conflicted":
          throw new TrustRootConflictedError(
            `log ${ownerLogIdLowerHex32} is conflicted`,
          );
        case "unavailable":
          throw new TrustRootNotFoundError(
            `log authority unavailable for ${ownerLogIdLowerHex32}: ${authority.detail}`,
          );
        default:
          throw new TrustRootNotFoundError(
            `log ${ownerLogIdLowerHex32} is not anchored (${authority.kind})`,
          );
      }
    },
  };
}
