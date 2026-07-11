/**
 * KS256 (Ethereum EOA) grant signing — construction moved to
 * @forestrie/grant-builder (plan-2607-12 Phase 2, FOR-350); the kit keeps only
 * the env/file plumbing and re-exports the builder API for compatibility.
 */

import { readFileSync } from "node:fs";

/** Ephemeral KS256 bootstrap private key hex from env file path. */
export function bootstrapKs256PrivateKeyHex(): string | undefined {
  const file = process.env.E2E_UNIVOCITY_KS256_BOOTSTRAP_KEY_FILE?.trim();
  if (!file) return undefined;
  return readFileSync(file, "utf8").trim();
}

export {
  KS256_PROTECTED_HEADER,
  ks256AddressFromPrivateKeyHex,
  mintKs256RootGrantWithWalletKey,
  randomKs256PrivateKeyHex,
  signGrantPayloadWithKs256Wallet,
  signGrantWithKs256WalletKey,
  signKs256RootStatement,
  verifyKs256GrantStatement,
} from "@forestrie/grant-builder";
