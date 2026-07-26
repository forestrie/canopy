/**
 * Kill-switch enforcement (plan-2607-43 slice 04, ADR-0059 D4).
 *
 * The indexer — never the data plane — flips the coordinator *operator* kill
 * switch for an account's root log via canopy-api's existing ops proxy route,
 * using the shared ops identity. Forward-only, one instance at a time.
 *
 * The operator switch is one shared bit, also used by manual ops action. The
 * `enforcementFrozen` marker on the account records whether THIS enforcement
 * path holds the freeze: the indexer only unfreezes what it froze, so a
 * manual ops freeze (marker false) is never undone by an account recovering
 * its balance.
 */

import type { Env } from "../env.js";
import type {
  AccountEntitlement,
  ReceivablesDO,
} from "../durableobjects/receivables.js";

export function enforcementArmed(env: Env): boolean {
  return env.ENFORCEMENT_ARMED?.trim() === "true";
}

/**
 * PUT the operator kill switch through canopy-api. Throws on any failure —
 * the caller records the error and the next sweep retries; the frozen marker
 * is only advanced after a confirmed flip.
 */
async function putKillSwitch(
  env: Env,
  root: string,
  enabled: boolean,
): Promise<void> {
  const origin = env.CANOPY_API_ORIGIN?.trim();
  const token = env.CANOPY_OPS_ADMIN_TOKEN?.trim();
  if (!origin || !token) {
    throw new Error(
      "ENFORCEMENT_ARMED is true but CANOPY_API_ORIGIN / CANOPY_OPS_ADMIN_TOKEN is unset — cannot reach the kill switch",
    );
  }
  const res = await fetch(
    `${origin}/api/payments/admin/registrations/${encodeURIComponent(root)}/enabled`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ enabled }),
    },
  );
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(
      `kill-switch PUT enabled=${enabled} for root ${root} failed: ${res.status} ${detail}`,
    );
  }
}

/**
 * Reconcile one account's kill switch with its arrears posture. Idempotent
 * per sweep; a failed flip throws so the sweep counts the error and retries
 * next tick.
 *
 * @returns what was done, for the sweep log.
 */
export async function enforceAccount(
  env: Env,
  stub: DurableObjectStub<ReceivablesDO>,
  entitlement: AccountEntitlement,
): Promise<"froze" | "unfroze" | null> {
  const id = entitlement.univocityInstanceId;
  if (!enforcementArmed(env)) {
    if (entitlement.arrears === "in-arrears") {
      console.log(
        `indexer[observe-only]: ${id} in arrears ` +
          `(balance ${entitlement.creditsBalance} < floor ${entitlement.creditFloor}); ` +
          `ENFORCEMENT_ARMED is not set — kill switch untouched`,
      );
    }
    return null;
  }

  if (entitlement.arrears === "in-arrears" && !entitlement.enforcementFrozen) {
    await putKillSwitch(env, entitlement.root, false);
    await stub.setEnforcementFrozen(id, true);
    console.log(
      `enforcement: froze ${id} (root ${entitlement.root}): ` +
        `balance ${entitlement.creditsBalance} < floor ${entitlement.creditFloor}`,
    );
    return "froze";
  }
  if (entitlement.arrears !== "in-arrears" && entitlement.enforcementFrozen) {
    await putKillSwitch(env, entitlement.root, true);
    await stub.setEnforcementFrozen(id, false);
    console.log(
      `enforcement: unfroze ${id} (root ${entitlement.root}): ` +
        `balance ${entitlement.creditsBalance} recovered above floor ${entitlement.creditFloor}`,
    );
    return "unfroze";
  }
  return null;
}
