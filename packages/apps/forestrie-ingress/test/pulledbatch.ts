/**
 * Test helpers for the pull -> ack contract: an ack must name the batch a
 * pull leased (seqLo, seqHi, leaseExpiry), so tests pull before they ack.
 */

import type {
  AckRequest,
  PullRequest,
  PullResponse,
} from "@canopy/forestrie-ingress-types";

/** One pulled LogGroup and the lease it was pulled under. */
export interface PulledBatch {
  logId: ArrayBuffer;
  seqLo: number;
  seqHi: number;
  leaseExpiry: number;
  count: number;
}

interface Puller {
  pull(request: PullRequest): Promise<PullResponse>;
}

export interface PullOptions {
  batchSize?: number;
  pollerId?: string;
  /** 0: the lease has expired on return, as if the commit outlasted it */
  visibilityMs?: number;
}

/** Pull once and return every LogGroup as a PulledBatch. */
export async function pullBatches(
  stub: Puller,
  {
    batchSize = 1000,
    pollerId = "test-poller",
    visibilityMs = 30000,
  }: PullOptions = {},
): Promise<PulledBatch[]> {
  const response = await stub.pull({ pollerId, batchSize, visibilityMs });
  // Each pull's lease is unique (at least one ms past the previous one), so
  // a short lease may not have expired yet: wait until it has.
  while (Date.now() <= response.leaseExpiry && visibilityMs === 0) {
    await new Promise((r) => setTimeout(r, 1));
  }
  return response.logGroups.map((g) => ({
    logId: g.logId,
    seqLo: g.seqLo,
    seqHi: g.seqHi,
    leaseExpiry: response.leaseExpiry,
    count: g.entries.length,
  }));
}

/** The batch for `logId` among `batches`; throws if it was not pulled. */
export function batchFor(
  batches: PulledBatch[],
  logId: ArrayBuffer,
): PulledBatch {
  const want = new Uint8Array(logId);
  const found = batches.find((b) => {
    const got = new Uint8Array(b.logId);
    return got.length === want.length && got.every((v, i) => v === want[i]);
  });
  if (!found) throw new Error("log was not pulled");
  return found;
}

/** Pull once and return the batch for `logId`. */
export async function pullBatch(
  stub: Puller,
  logId: ArrayBuffer,
  options: PullOptions = {},
): Promise<PulledBatch> {
  return batchFor(await pullBatches(stub, options), logId);
}

/** The ack that commits all of `batch` from `firstLeafIndex`. */
export function ackOf(
  batch: PulledBatch,
  firstLeafIndex: bigint,
  massifHeight = 14,
  limit = batch.count,
): AckRequest {
  return {
    logId: batch.logId,
    seqLo: batch.seqLo,
    seqHi: batch.seqHi,
    leaseExpiry: batch.leaseExpiry,
    limit,
    firstLeafIndex,
    massifHeight,
  };
}
