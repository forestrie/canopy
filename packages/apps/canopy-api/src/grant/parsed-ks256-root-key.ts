/**
 * KS256 forest / trust-root key material (20-byte Ethereum address).
 */

import { COSE_ALG_KS256 } from "../cose/cose-key.js";

/** Parsed KS256 root: contract address or EOA used for COSE KS256 verify. */
export interface ParsedKs256RootKey {
  kind: "KS256";
  alg: typeof COSE_ALG_KS256;
  /** 20-byte address (no 0x prefix). */
  address: Uint8Array;
}

export function isParsedKs256RootKey(
  key: unknown,
): key is ParsedKs256RootKey {
  return (
    typeof key === "object" &&
    key !== null &&
    (key as ParsedKs256RootKey).kind === "KS256" &&
    (key as ParsedKs256RootKey).address instanceof Uint8Array &&
    (key as ParsedKs256RootKey).address.length === 20
  );
}
