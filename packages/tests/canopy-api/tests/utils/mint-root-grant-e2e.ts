/**
 * Mint a root creation grant for an ephemeral Imutable bootstrap variant.
 */

import type { APIRequestContext } from "@playwright/test";
import type { E2eBootstrapVariant } from "./e2e-bootstrap-variant.js";

export interface MintRootGrantResult {
  grantBase64: string;
  bootstrapKey: Uint8Array;
  bootstrapAlg: number;
}

/** Prepare genesis + root creation grant for `rootLogId`. */
export async function mintRootGrantForVariant(
  request: APIRequestContext,
  rootLogId: string,
  variant: E2eBootstrapVariant,
  curatorToken: string,
): Promise<MintRootGrantResult> {
  const boot = await variant.fetchBootstrapKey();
  await variant.ensureGenesis(request, rootLogId, curatorToken, boot.key);
  const { grantBase64 } = variant.mintRootGrant(rootLogId, boot.key);
  return {
    grantBase64,
    bootstrapKey: boot.key,
    bootstrapAlg: boot.alg,
  };
}

export { COSE_ALG_ES256, COSE_ALG_KS256 } from "./univocity-genesis-e2e.js";
