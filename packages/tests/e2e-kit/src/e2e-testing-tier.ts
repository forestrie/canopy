/**
 * ARC-0024 testing tiers for canopy CI and local runs.
 *
 * - **T2** — component bootstrap: ephemeral Imutable provision (`deploy provision e2e`).
 * - **T3** — component system: pinned lane contracts from env; no re-provision.
 *
 * Cross-repo lane integration (system-testing `system-e2e`) is T3 and owned by
 * `forestrie/system-testing`, not `tests-system.yml`.
 */

export type E2eTestingTier = "t2" | "t3";

/** Parse `E2E_TESTING_TIER` (default **t3**). */
export function parseE2eTestingTier(raw?: string): E2eTestingTier {
  const v = raw?.trim().toLowerCase();
  if (v === "t2") return "t2";
  if (v === "t3") return "t3";
  return "t3";
}

/** True when CI/local should provision ephemeral bootstrap contracts. */
export function isEphemeralBootstrapTier(raw?: string): boolean {
  return parseE2eTestingTier(raw) === "t2";
}
