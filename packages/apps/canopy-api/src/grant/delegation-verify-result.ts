import type { ParsedEcPublicKey } from "@forestrie/encoding";

export interface DelegationVerifyResult {
  delegatedKey: CryptoKey | null;
  parsedKey: ParsedEcPublicKey;
  signatureVerified: boolean;
}
