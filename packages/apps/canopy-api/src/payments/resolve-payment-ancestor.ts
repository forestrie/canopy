import { logIdToWireBytes } from "../grant/log-id-wire.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import {
  readRegistration,
  type RegistrationStoreEnv,
} from "./registration-store.js";

const MAX_ANCESTOR_WALK = 32;

export type ResolvePaymentAncestorResult =
  | { ok: true; root: string }
  | { ok: false; reason: "missing" | "cycle" | "depth" };

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
      return { ok: true, root: current };
    }
    if (!record.endorsedBy?.trim()) {
      return { ok: false, reason: "missing" };
    }
    current = record.endorsedBy.trim();
  }
  return { ok: false, reason: "depth" };
}
