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
 * ancestor's `chainBinding` (ADR-0058 §2): chain-native, stable, CAIP-2 shaped,
 * and already carried on every registration record.
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
 * Stable key for a liable account, for use as a receivables-store id.
 *
 * CAIP-2-shaped: `<chainId>:<univocityAddr>`, lowercased so that a
 * checksummed and non-checksummed address resolve to one account.
 */
export function liableAccountKey(account: LiableAccount): string {
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
      if (!chainId || !univocityAddr) {
        // A payment-authoritative root with no chain binding cannot be billed:
        // there is no account to accrue against. Treat as unresolvable rather
        // than inventing a key.
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
