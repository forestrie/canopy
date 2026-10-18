/**
 * What ADR-0053 Part A (register-grant auto-forward) and Part B (prepare) send
 * to the delegation coordinator's `POST /api/logs/{logId}/public-root` for a
 * child log, derived from its create grant.
 *
 * A create grant's grantData carries no alg, so its length decides the key
 * type, as univocity (`GrantDataInvalidKeyLength`) and arbor
 * (`grantDataIdentity`) already do: 64 bytes is an ES256 `x‖y` key, 20 bytes a
 * KS256 address. Every child forward carries the forest's chain binding so that
 * the coordinator can select ERC-1271 RPC for a contract root at any depth, and
 * a grandchild can inherit the chain from its parent's registered root.
 * See the [ADR-0053 amendment of 2026-10-18](https://github.com/forestrie/devdocs/blob/main/archive/2607/adr/adr-0053-child-log-onboarding-parent-authorized.md)
 * and plan-2610-03 decisions D2 and D6.
 */

import { COSE_ALG_ES256, COSE_ALG_KS256 } from "../cose/cose-key.js";
import type { ForestGenesisChainBinding } from "./genesis-wire.js";

/** A child's root key as the coordinator public-root POST takes it. */
export interface ChildRootForward {
  /** {@link COSE_ALG_ES256} or {@link COSE_ALG_KS256}. */
  genesisAlg: number;
  /** 64-byte ES256 `x‖y` or 20-byte KS256 address. */
  bootstrapKey: Uint8Array;
}

/**
 * The chain binding carried on a child forward. `univocityAddr` is known only
 * when the forest's genesis is at hand (the parent is the forest root); the
 * coordinator stores just `chainId` either way.
 */
export interface ForwardChainBinding {
  /** Decimal EIP-155 chain id. */
  chainId: string;
  /** Univocity contract address, 40 lowercase hex characters, no `0x`. */
  univocityAddr?: string;
}

/**
 * Type a child root from create-grant grantData by length.
 *
 * @returns the forward material, or `null` when the length is neither 64
 *   (ES256) nor 20 (KS256). Part A then skips the forward; Part B refuses.
 */
export function childRootForwardFromGrantData(
  grantData: Uint8Array,
): ChildRootForward | null {
  if (grantData.length === 64) {
    return { genesisAlg: COSE_ALG_ES256, bootstrapKey: grantData };
  }
  if (grantData.length === 20) {
    return { genesisAlg: COSE_ALG_KS256, bootstrapKey: grantData };
  }
  return null;
}

/** The forward chain binding for a forest genesis, or none for legacy v0. */
export function forwardChainBindingFromGenesis(
  binding: ForestGenesisChainBinding | null,
): ForwardChainBinding | undefined {
  if (!binding) return undefined;
  return {
    chainId: binding.chainId,
    univocityAddr: Array.from(binding.address)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  };
}
