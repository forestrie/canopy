/**
 * Legacy univocity instance identifier forms → canonical CAIP-10 (ADR-0059
 * D1/D6). This module is the ONLY holder of legacy-format knowledge — it is
 * allowlisted in `scripts/check-naming.mjs` so that knowledge cannot spread.
 * Its two callers are the boot-time value rewrite in DelegationStoreDO and
 * the PUT /api/logs/{logId}/webhook value-form shim; both retire in
 * plan-2607-43 slice 05, taking this module with them.
 */

/** Legacy pre-ADR-0059 bespoke instance key form: `{decimalChainId}:{40hex}`. */
const LEGACY_BESPOKE_PATTERN = /^([1-9][0-9]*):(0x)?([0-9a-f]{40})$/;

/** Near-canonical CAIP-10 missing the `0x` prefix, any hex case. */
const LEGACY_UNPREFIXED_CAIP_PATTERN =
  /^eip155:([1-9][0-9]*):([0-9a-fA-F]{40})$/;

/**
 * Render a legacy-form instance identifier as a canonical CAIP-10 univocity
 * instance id, or null when the value is not a recognised legacy form.
 * Canonical values match neither legacy pattern, so an already-canonical
 * input also returns null — callers gate on `isUnivocityInstanceId` first.
 */
export function univocityInstanceIdFromLegacyInstanceKey(
  value: string,
): string | null {
  const bespoke = LEGACY_BESPOKE_PATTERN.exec(value);
  if (bespoke) return `eip155:${bespoke[1]}:0x${bespoke[3]}`;
  const unprefixed = LEGACY_UNPREFIXED_CAIP_PATTERN.exec(value);
  if (unprefixed)
    return `eip155:${unprefixed[1]}:0x${unprefixed[2].toLowerCase()}`;
  return null;
}
