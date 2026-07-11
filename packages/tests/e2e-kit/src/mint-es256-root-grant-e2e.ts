/**
 * ES256 root creation grant — construction moved to @forestrie/grant-builder
 * (plan-2607-12 Phase 2, FOR-350); the kit keeps only the env/file plumbing
 * and re-exports the builder API for compatibility.
 */

import { readFileSync } from "node:fs";

/** Ephemeral ES256 bootstrap PEM from `E2E_UNIVOCITY_ES256_BOOTSTRAP_PEM_FILE`. */
export function bootstrapEs256PrivateKeyPem(): string | undefined {
  const file = process.env.E2E_UNIVOCITY_ES256_BOOTSTRAP_PEM_FILE?.trim();
  if (file) {
    return readFileSync(file, "utf8").trim();
  }
  return undefined;
}

export { mintEs256RootGrantWithBootstrapPem } from "@forestrie/grant-builder";
