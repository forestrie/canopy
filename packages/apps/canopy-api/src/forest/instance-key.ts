/**
 * Univocity instance key derivation (FOR-468).
 *
 * The instance a log belongs to is the account identity already carried on
 * `RegistrationRecord.chainBinding` — `{ chainId, univocityAddr }`. Rendering
 * it as `{chainId}:{univocityAddr}` gives the delegation coordinator a stable,
 * opaque label to hang an instance-level webhook on, without introducing a
 * second notion of "account". The webhook itself is emphatically **not** an
 * identity dimension; see
 * [ADR-0005 amendment](../../../../docs/adr/adr-0005-delegation-webhook-delivery.md).
 */

import type { ForestGenesisChainBinding } from "./genesis-wire.js";

/** Mirrors the coordinator's accepted instance-key shape. */
const INSTANCE_KEY_PATTERN = /^[0-9a-z][0-9a-z._:-]{0,127}$/;

/**
 * Build an instance key from a stored chain binding.
 *
 * @param binding - `{ chainId, univocityAddr }` from a `RegistrationRecord`.
 * @returns Canonical instance key, or `undefined` when the binding does not
 *   render to a key the coordinator would accept. Callers treat `undefined` as
 *   "no instance binding" rather than an error: a log with no instance simply
 *   inherits nothing, which is a supported configuration.
 */
export function instanceKeyFromStoredChainBinding(binding: {
  chainId: string;
  univocityAddr: string;
}): string | undefined {
  const chainId = binding.chainId?.trim().toLowerCase() ?? "";
  const addr = binding.univocityAddr?.trim().toLowerCase().replace(/^0x/, "");
  if (!chainId || !addr) return undefined;
  const key = `${chainId}:${addr}`;
  return INSTANCE_KEY_PATTERN.test(key) ? key : undefined;
}

/**
 * Build an instance key from a genesis chain binding.
 *
 * @param binding - Genesis wire binding (address as raw bytes).
 * @returns Canonical instance key, or `undefined` — see
 *   {@link instanceKeyFromStoredChainBinding}.
 */
export function instanceKeyFromGenesisChainBinding(
  binding: ForestGenesisChainBinding,
): string | undefined {
  const addrHex = Array.from(binding.address)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return instanceKeyFromStoredChainBinding({
    chainId: binding.chainId,
    univocityAddr: addrHex,
  });
}
