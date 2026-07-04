import { COSE_ALG_KS256 } from "./cose-key.js";

export interface ParsedKs256RootKey {
  kind: "KS256";
  alg: typeof COSE_ALG_KS256;
  address: Uint8Array;
}

export function isParsedKs256RootKey(key: unknown): key is ParsedKs256RootKey {
  return (
    typeof key === "object" &&
    key !== null &&
    (key as ParsedKs256RootKey).kind === "KS256" &&
    (key as ParsedKs256RootKey).address instanceof Uint8Array &&
    (key as ParsedKs256RootKey).address.length === 20
  );
}

export type RootVerifyKey = CryptoKey | ParsedKs256RootKey;
