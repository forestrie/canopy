/**
 * Accrual indexer composition (plan-2607-43 slice 03): enumerate registered
 * accounts, walk `CheckpointPublished` from each account's watermark with a
 * confirmation lag, and apply idempotent accrual batches to the per-account
 * ReceivablesDO. Observe-only: balances may run negative and arrears is
 * computed, but the kill switch is never touched until `ENFORCEMENT_ARMED`
 * (slice 04).
 *
 * Backfill posture: a first-seen account starts observing from the current
 * confirmed head (watermark initialised without a scan) unless
 * `INDEXER_BACKFILL_FROM_BLOCK` names an explicit start. Pre-pricing
 * (FOR-438) there is nothing to bill retroactively, and ADR-0058 §7 makes
 * chain reconciliation the backstop for anything missed.
 */

import {
  parseSupportedChainsRpc,
  rpcUrlsForChainId,
} from "@forestrie/chain-rpc";
import type { Env } from "../env.js";
import type { AccountRef } from "../durableobjects/receivables.js";
import {
  fetchCheckpointEvents,
  fetchLatestBlock,
} from "./checkpoint-log-source.js";
import { listRegisteredAccounts } from "./instance-accounts.js";

/** Blocks behind head the scan stops — reorg tolerance on Base. */
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

async function indexAccount(
  env: Env,
  account: AccountRef,
  rpcUrls: string[],
): Promise<{ scanned: number; applied: number }> {
  const confirmations = intFromEnv(
    env.INDEXER_CONFIRMATIONS,
    DEFAULT_CONFIRMATIONS,
  );
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

  const head = await fetchLatestBlock(rpcUrls);
  const confirmedHead = head - confirmations;
  if (confirmedHead < 0) return { scanned: 0, applied: 0 };

  const { lastBlock } = await stub.getIndexState(account.univocityInstanceId);

  let from: number;
  if (lastBlock !== null) {
    from = lastBlock + 1;
  } else {
    const backfill = Number.parseInt(env.INDEXER_BACKFILL_FROM_BLOCK ?? "", 10);
    if (Number.isSafeInteger(backfill) && backfill >= 0) {
      from = backfill;
    } else {
      // First sight: initialise the watermark at the confirmed head and
      // observe forward only. Recorded, so the choice is auditable.
      await stub.applyCheckpointEvents(account, [], confirmedHead);
      console.log(
        `indexer: ${account.univocityInstanceId} watermark initialised at ${confirmedHead} (observe-forward)`,
      );
      return { scanned: 0, applied: 0 };
    }
  }

  let scanned = 0;
  let applied = 0;
  let ranges = 0;
  const contractAddress = `0x${account.univocityAddr}`;
  while (from <= confirmedHead && ranges < maxRanges) {
    const to = Math.min(from + maxRange - 1, confirmedHead);
    const events = await fetchCheckpointEvents(
      rpcUrls,
      contractAddress,
      from,
      to,
    );
    const entitlement = await stub.applyCheckpointEvents(
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
    if (entitlement.arrears === "in-arrears") {
      console.log(
        `indexer[observe-only]: ${account.univocityInstanceId} in arrears ` +
          `(balance ${entitlement.creditsBalance} < floor ${entitlement.creditFloor}); ` +
          `ENFORCEMENT_ARMED is not set — kill switch untouched`,
      );
    }
    from = to + 1;
    ranges += 1;
  }
  return { scanned, applied };
}

/**
 * One cron sweep. Per-account failures degrade to logs — one bad RPC or one
 * poisoned account must not starve the rest of the sweep.
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
  const rawChains = env.SUPPORTED_CHAINS_RPC?.trim();
  if (!rawChains) {
    console.warn("indexer: SUPPORTED_CHAINS_RPC unset; sweep skipped");
    return summary;
  }
  if (!env.R2_GRANTS) {
    console.warn("indexer: R2_GRANTS binding absent; sweep skipped");
    return summary;
  }
  const chains = parseSupportedChainsRpc(rawChains);
  const accounts = await listRegisteredAccounts(env.R2_GRANTS);
  summary.accounts = accounts.length;

  for (const account of accounts) {
    const rpcUrls = rpcUrlsForChainId(chains, account.chainId);
    if (!rpcUrls) {
      console.warn(
        `indexer: no RPC configured for chain ${account.chainId} (${account.univocityInstanceId}); skipped`,
      );
      continue;
    }
    try {
      const r = await indexAccount(env, account, rpcUrls);
      summary.scanned += r.scanned;
      summary.applied += r.applied;
    } catch (error) {
      summary.errors += 1;
      console.error(
        `indexer: ${account.univocityInstanceId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log(
    `indexer: sweep complete accounts=${summary.accounts} ranges=${summary.scanned} events=${summary.applied} errors=${summary.errors}`,
  );
  return summary;
}
