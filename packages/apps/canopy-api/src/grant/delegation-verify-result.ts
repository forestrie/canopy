import type { ParsedEcPublicKey } from "@canopy/encoding";

export interface DelegationVerifyResult {
  delegatedKey: CryptoKey | null;
  parsedKey: ParsedEcPublicKey;
  signatureVerified: boolean;
}
