import { logIdToWireBytes } from "../grant/log-id-wire.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import {
  readRegistration,
  type RegistrationStoreEnv,
} from "./registration-store.js";

const MAX_ANCESTOR_WALK = 32;

/**
 * The party liable to the pipe operator for a registration's activity.
 *
 * Only the **root-log owner** is liable (ADR-0058 §1) — canopy never bills or
 * meters individual logs in a hierarchy, and recoupment across a grant tree is
 * the root owner's own problem. The account key is the payment-authoritative
 * ancestor's `chainBinding` (ADR-0058 §2): chain-native, stable, and already
 * carried on every registration record.
 *
 * It is **resolved by the walk, never self-declared**. A `regular` registration
 * cannot nominate its own account — that would let an owner shed arrears by
 * re-parenting.
 */
export interface LiableAccount {
  /** UUID of the payment-authoritative registration (the root log). */
  root: string;
  chainId: string;
  univocityAddr: string;
}

export type ResolvePaymentAncestorResult =
  | { ok: true; root: string; account: LiableAccount }
  | { ok: false; reason: "missing" | "cycle" | "depth" };

/**
 * `chainBinding.chainId` is a **bare decimal chain id** (e.g. `"84532"`), not a
 * CAIP-2 identifier (`"eip155:84532"`). Registration records are written that
 * way — see `forest/genesis-cache.ts`, `String(legacyChains[0])`.
 *
 * The format is pinned here deliberately. The account key is *derived* from
 * this field, so if some writer ever emitted the CAIP-2 form instead, one
 * operator would silently become **two accounts** with split receivables and
 * nothing to detect it. Rejecting a non-conforming value is far cheaper than
 * discovering a divided ledger later.
 */
const BARE_CHAIN_ID = /^\d+$/;
/**
 * Bare lowercase hex, **no `0x` prefix** — `registration-store.ts` hex-encodes
 * the 20 address bytes directly. Accepts either case on read; the key is
 * lowercased so a hand-written checksummed value cannot split an account.
 */
const UNIVOCITY_ADDR = /^[0-9a-fA-F]{40}$/;

/** Whether a chain binding can be used to key a receivables account. */
export function isKeyableChainBinding(
  chainId: string | undefined,
  univocityAddr: string | undefined,
): boolean {
  return (
    !!chainId &&
    !!univocityAddr &&
    BARE_CHAIN_ID.test(chainId) &&
    UNIVOCITY_ADDR.test(univocityAddr)
  );
}

/**
 * Stable key for a liable account, for use as a receivables-store id.
 *
 * `<chainId>:<univocityAddr>`, lowercased so a checksummed and a
 * non-checksummed address resolve to one account rather than two.
 *
 * Throws on a non-conforming binding rather than keying it — see
 * {@link isKeyableChainBinding}.
 */
export function liableAccountKey(account: LiableAccount): string {
  if (!isKeyableChainBinding(account.chainId, account.univocityAddr)) {
    throw new Error(
      `unkeyable chain binding for account root ${account.root}: ` +
        `chainId must be a bare decimal id and univocityAddr 40 hex chars`,
    );
  }
  return `${account.chainId}:${account.univocityAddr}`.toLowerCase();
}

/**
 * Walk `endorsedBy` from `R` until a payment-authoritative registration.
 */
export async function resolvePaymentAncestor(
  env: RegistrationStoreEnv,
  endorserRouteSegment: string,
): Promise<ResolvePaymentAncestorResult> {
  let current: string;
  try {
    current = bytesToUuid(logIdToWireBytes(endorserRouteSegment));
  } catch {
    return { ok: false, reason: "missing" };
  }

  const visited = new Set<string>();
  for (let depth = 0; depth < MAX_ANCESTOR_WALK; depth++) {
    if (visited.has(current)) {
      return { ok: false, reason: "cycle" };
    }
    visited.add(current);

    let wire: Uint8Array;
    try {
      wire = logIdToWireBytes(current);
    } catch {
      return { ok: false, reason: "missing" };
    }

    const record = await readRegistration(env, wire);
    if (!record) {
      return { ok: false, reason: "missing" };
    }
    if (record.class === "payment-authoritative") {
      const chainId = record.chainBinding?.chainId?.trim();
      const univocityAddr = record.chainBinding?.univocityAddr?.trim();
      if (!isKeyableChainBinding(chainId, univocityAddr)) {
        // A payment-authoritative root whose chain binding cannot key an
        // account cannot be billed. Treat as unresolvable rather than
        // inventing a key or keying an unpinned format.
        return { ok: false, reason: "missing" };
      }
      return {
        ok: true,
        root: current,
        account: { root: current, chainId, univocityAddr },
      };
    }
    if (!record.endorsedBy?.trim()) {
      return { ok: false, reason: "missing" };
    }
    current = record.endorsedBy.trim();
  }
  return { ok: false, reason: "depth" };
}
