/**
 * One account per univocity instance (ADR-0059, plan-2607-43 slice 01).
 *
 * A CAS-backed uniqueness index claimed at genesis, before the registration
 * record is written: `forests/index/chain-binding/{univocityInstanceId}` →
 * ASCII UUID of the forest root R. A second genesis naming the same instance
 * is a conflict, not a second account — this is what stops two forests
 * claiming one contract (and, later, what the accrual indexer enumerates).
 * Claiming is idempotent for the same R so genesis retries are safe.
 */

import type { UnivocityInstanceId } from "@canopy/univocity-instance-id";

export interface InstanceRegistryEnv {
  R2_GRANTS: R2Bucket;
}

export type ClaimInstanceResult =
  | { ok: true }
  | { ok: false; claimedBy: string };

function instanceIndexR2Key(id: UnivocityInstanceId): string {
  return `forests/index/chain-binding/${id}`;
}

/**
 * Claim `id` for forest root `rUuid`.
 *
 * @returns `{ ok: true }` when this R holds the claim (fresh or retried);
 *   `{ ok: false, claimedBy }` when another R already holds it.
 */
export async function claimUnivocityInstance(
  env: InstanceRegistryEnv,
  id: UnivocityInstanceId,
  rUuid: string,
): Promise<ClaimInstanceResult> {
  const key = instanceIndexR2Key(id);
  const written = await env.R2_GRANTS.put(key, rUuid, {
    httpMetadata: { contentType: "text/plain" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written) return { ok: true };

  const existing = await env.R2_GRANTS.get(key);
  const claimedBy = existing ? (await existing.text()).trim() : "";
  if (claimedBy === rUuid) return { ok: true };
  return { ok: false, claimedBy };
}

/**
 * Read the forest root R holding the claim on `id`, if any.
 */
export async function readUnivocityInstanceClaim(
  env: InstanceRegistryEnv,
  id: UnivocityInstanceId,
): Promise<string | null> {
  const got = await env.R2_GRANTS.get(instanceIndexR2Key(id));
  if (!got) return null;
  const value = (await got.text()).trim();
  return value || null;
}
