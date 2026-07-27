/**
 * Accrual indexer composition (plan-2607-43 slice 03): enumerate registered
 * accounts, walk `CheckpointPublished` from each account's watermark up to
 * the chain's safe head, and apply idempotent accrual batches to the
 * per-account ReceivablesDO. Observe-only: balances may run negative and
 * arrears is computed, but the kill switch is never touched until
 * `ENFORCEMENT_ARMED` (slice 04).
 *
 * Backfill posture (plan-2607-04 / FOR-477): a first-seen account scans from
 * its recorded `registrationBlock` — the chain head observed when its
 * reservation completed to `registered`, the account's metering floor —
 * inclusive, so checkpoints anchored between registration and first sight
 * are counted. Records without a floor (legacy, or a failed genesis-time
 * observation, ops-repairable) observe forward from the scan bound;
 * ADR-0058 §7 chain reconciliation is the backstop for anything missed.
 * The retired `INDEXER_BACKFILL_FROM_BLOCK` env knob is gone: the floor is
 * a fact about the account, not deployment config.
 */

import {
  parseSupportedChainsRpc,
  rpcUrlsForChainId,
} from "@forestrie/chain-rpc";
import type { Env } from "../env.js";
import type { AccountRef } from "../durableobjects/receivables.js";
import {
  fetchCheckpointEvents,
  fetchScanBound,
} from "./checkpoint-log-source.js";
import { enforceAccount } from "./enforcement.js";
import { listRegisteredAccounts } from "./instance-accounts.js";

/** Fallback confirmations when a chain does not serve the `safe` tag. */
const DEFAULT_CONFIRMATIONS = 6;
/** eth_getLogs span per request; public RPCs commonly cap around 10k. */
const DEFAULT_MAX_BLOCK_RANGE = 5000;
/** Ranges per account per run — bounds cron CPU; the watermark resumes. */
const DEFAULT_MAX_RANGES_PER_RUN = 6;
/**
 * How long first sight holds for an explicit-null floor awaiting ops repair
 * (plan-2607-05 R1a). Long enough for a human to act on the genesis-time
 * observation failure, short enough that an unrepaired account still starts
 * metering the same day.
 */
const NULL_FLOOR_REPAIR_GRACE_SECONDS = 3600;

function withinNullFloorRepairGrace(reservedAt: number | undefined): boolean {
  if (reservedAt === undefined) return false;
  return (
    Math.floor(Date.now() / 1000) - reservedAt < NULL_FLOOR_REPAIR_GRACE_SECONDS
  );
}

export interface IndexerRunSummary {
  accounts: number;
  scanned: number;
  applied: number;
  errors: number;
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

async function indexAccount(
  env: Env,
  account: AccountRef,
  rpcUrls: string[],
  scanBound: number,
): Promise<{ scanned: number; applied: number }> {
  const maxRange = intFromEnv(
    env.INDEXER_MAX_BLOCK_RANGE,
    DEFAULT_MAX_BLOCK_RANGE,
  );
  const maxRanges = intFromEnv(
    env.INDEXER_MAX_RANGES_PER_RUN,
    DEFAULT_MAX_RANGES_PER_RUN,
  );

  const stub = env.RECEIVABLES_DO.get(
    env.RECEIVABLES_DO.idFromName(account.univocityInstanceId),
  );

  if (scanBound < 0) return { scanned: 0, applied: 0 };

  const state = await stub.getIndexState(account.univocityInstanceId);
  const lastBlock = state.lastBlock;
  let entitlement = state.entitlement;

  let from: number;
  if (lastBlock !== null) {
    from = lastBlock + 1;
  } else {
    // First sight. Starter credits (slice 04) are granted here, before any
    // floor decision, so a fresh account is not born frozen once armed —
    // whichever scan-start applies. Idempotent per account, so the retry
    // when the floor still sits above the scan bound is harmless.
    const starter = intFromEnv(env.STARTER_CREDITS, 0);
    if (starter > 0) {
      await stub.recordPayment(
        account,
        `starter:${account.univocityInstanceId}`,
        starter,
      );
      console.log(
        `indexer: ${account.univocityInstanceId} granted ${starter} starter credits`,
      );
    }
    if (account.registrationBlock != null) {
      // Metering floor (plan-2607-04): scan from the recorded registration
      // block, inclusive — counts checkpoints anchored between registration
      // and this sweep, the FOR-477 first-sight miss. The floor commonly
      // sits above the safe-head scan bound for the first sweeps after
      // registration; the loop below then scans nothing and the watermark
      // stays uninitialised until the bound catches up.
      from = account.registrationBlock;
      console.log(
        `indexer: ${account.univocityInstanceId} first sight from registrationBlock ${from}`,
      );
    } else if (
      account.registrationBlock === null &&
      withinNullFloorRepairGrace(account.reservedAt)
    ) {
      // Explicit null: the genesis-time observation failed and an ops
      // repair is pending (plan-2607-05 R1a). Observe-forward here would
      // initialise the forward-only watermark and make the repair inert
      // within one cron tick — so hold first sight while the record is
      // young enough for a repair to plausibly land.
      console.log(
        `indexer: ${account.univocityInstanceId} first sight held; awaiting registrationBlock repair`,
      );
      return { scanned: 0, applied: 0 };
    } else {
      // No usable floor (legacy record, or a null floor whose repair grace
      // expired): initialise the watermark at the scan bound and observe
      // forward only. Recorded, so the choice is auditable; ADR-0058 §7
      // reconciliation is the backstop for anything missed.
      await stub.applyCheckpointEvents(account, [], scanBound);
      console.log(
        `indexer: ${account.univocityInstanceId} watermark initialised at ${scanBound} (observe-forward)`,
      );
      return { scanned: 0, applied: 0 };
    }
  }

  let scanned = 0;
  let applied = 0;
  let ranges = 0;
  const contractAddress = `0x${account.univocityAddr}`;
  while (from <= scanBound && ranges < maxRanges) {
    const to = Math.min(from + maxRange - 1, scanBound);
    const events = await fetchCheckpointEvents(
      rpcUrls,
      contractAddress,
      from,
      to,
    );
    entitlement = await stub.applyCheckpointEvents(
      account,
      events.map((e) => ({
        idempotencyKey: e.idempotencyKey,
        logKind: e.logKind,
        size: e.size,
      })),
      to,
    );
    scanned += 1;
    applied += events.length;
    from = to + 1;
    ranges += 1;
  }

  // Reconcile the kill switch with the (possibly unchanged) posture every
  // sweep — recovery via a credits purchase must unfreeze without waiting
  // for new chain events. Observe-only logging lives in enforceAccount.
  if (entitlement) {
    await enforceAccount(env, stub, entitlement);
  }
  return { scanned, applied };
}

/**
 * One cron sweep. Per-account failures degrade to logs, and the sweep body
 * itself is guarded — a malformed chain config or an R2 failure must become
 * an app-level `sweep failed` line, never an unhandled rejection inside the
 * scheduled handler's waitUntil (plan-2607-03 A1). Exactly one summary line
 * is emitted per tick, whatever happened.
 */
export async function runCheckpointIndexer(
  env: Env,
): Promise<IndexerRunSummary> {
  const summary: IndexerRunSummary = {
    accounts: 0,
    scanned: 0,
    applied: 0,
    errors: 0,
  };
  try {
    const rawChains = env.SUPPORTED_CHAINS_RPC?.trim();
    if (!rawChains) {
      console.warn("indexer: SUPPORTED_CHAINS_RPC unset; sweep skipped");
    } else if (!env.R2_GRANTS) {
      console.warn("indexer: R2_GRANTS binding absent; sweep skipped");
    } else {
      const chains = parseSupportedChainsRpc(rawChains);
      const accounts = await listRegisteredAccounts(env.R2_GRANTS);
      summary.accounts = accounts.length;
      const confirmations = intFromEnv(
        env.INDEXER_CONFIRMATIONS,
        DEFAULT_CONFIRMATIONS,
      );

      // One scan bound per chain per sweep: fewer RPC calls, and no
      // intra-sweep head skew between accounts on the same chain.
      const bounds = new Map<string, number>();

      for (const account of accounts) {
        const rpcUrls = rpcUrlsForChainId(chains, account.chainId);
        if (!rpcUrls) {
          console.warn(
            `indexer: no RPC configured for chain ${account.chainId} (${account.univocityInstanceId}); skipped`,
          );
          continue;
        }
        try {
          let bound = bounds.get(account.chainId);
          if (bound === undefined) {
            bound = await fetchScanBound(rpcUrls, confirmations);
            bounds.set(account.chainId, bound);
          }
          const r = await indexAccount(env, account, rpcUrls, bound);
          summary.scanned += r.scanned;
          summary.applied += r.applied;
        } catch (error) {
          summary.errors += 1;
          console.error(
            `indexer: ${account.univocityInstanceId} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } catch (error) {
    summary.errors += 1;
    console.error(
      `indexer: sweep failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  console.log(
    `indexer: sweep complete accounts=${summary.accounts} ranges=${summary.scanned} events=${summary.applied} errors=${summary.errors}`,
  );
  return summary;
}
