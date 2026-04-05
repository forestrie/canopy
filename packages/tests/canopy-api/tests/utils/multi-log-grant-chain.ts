/**
 * Orchestration helpers for auth → data log delegation e2e
 * (`auth-data-log-chain.spec.ts`).
 */

import { encode as encodeCbor } from "cbor-x";

/** Deterministic statement bytes for delegated data-log register-statement. */
export function e2eDataLogDelegationStatementPayload(
  dataLogId: string,
): Uint8Array {
  const encoded = encodeCbor({
    kind: "canopy-e2e-data-log-delegation-statement",
    dataLogId,
    v: 1,
  });
  const u8 =
    encoded instanceof Uint8Array
      ? encoded
      : new Uint8Array(encoded as ArrayLike<number>);
  return new Uint8Array(u8);
}
