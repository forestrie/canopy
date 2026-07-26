/**
 * Accrual indexer composition (plan-2607-43 slice 03): enumerate registered
 * accounts, walk `CheckpointPublished` from each account's watermark up to
 * the chain's safe head, and apply idempotent accrual batches to the
 * per-account ReceivablesDO. Observe-only: balances may run negative and
 * arrears is computed, but the kill switch is never touched until
 * `ENFORCEMENT_ARMED` (slice 04).
 *
 * Backfill posture: a first-seen account starts observing from the current
 * scan bound (watermark initialised without a scan) unless
 * `INDEXER_BACKFILL_FROM_BLOCK` — a JSON map `{chainId: block}` — names an
 * explicit start for its chain. Pre-pricing (FOR-438) there is nothing to
 * bill retroactively, and ADR-0058 §7 makes chain reconciliation the
 * backstop for anything missed.
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

/**
 * `INDEXER_BACKFILL_FROM_BLOCK` is a per-chain JSON map — cross-chain block
 * heights are not comparable, and a deployment-global scalar would latch
 * every future first-seen account into a deep backfill (plan-2607-03 E5).
 * Documented as a one-shot ops action: set, let first sight consume it,
 * unset.
 */
function backfillMap(raw: string | undefined): Record<string, number> {
  const trimmed = raw?.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      // A bare number is the retired deployment-global scalar (E5) — warn
      // rather than silently latching nothing.
      throw new Error("not an object");
    }
    const out: Record<string, number> = {};
    for (const [chainId, block] of Object.entries(parsed)) {
      if (
        typeof block === "number" &&
        Number.isSafeInteger(block) &&
        block >= 0
      ) {
        out[chainId] = block;
      }
    }
    return out;
  } catch {
    console.warn(
      "indexer: INDEXER_BACKFILL_FROM_BLOCK is not a JSON {chainId: block} map; ignored",
    );
    return {};
  }
}

async function indexAccount(
  env: Env,
  account: AccountRef,
  rpcUrls: string[],
  scanBound: number,
  backfillFrom: number | undefined,
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
  } else if (backfillFrom !== undefined) {
    from = backfillFrom;
  } else {
    // First sight: initialise the watermark at the scan bound and observe
    // forward only. Recorded, so the choice is auditable.
    await stub.applyCheckpointEvents(account, [], scanBound);
    // Starter credits (slice 04): granted the moment metering starts, so a
    // fresh account is not born frozen once armed. Idempotent per account.
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
    console.log(
      `indexer: ${account.univocityInstanceId} watermark initialised at ${scanBound} (observe-forward)`,
    );
    return { scanned: 0, applied: 0 };
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
      const backfill = backfillMap(env.INDEXER_BACKFILL_FROM_BLOCK);
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
          const r = await indexAccount(
            env,
            account,
            rpcUrls,
            bound,
            backfill[account.chainId],
          );
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
