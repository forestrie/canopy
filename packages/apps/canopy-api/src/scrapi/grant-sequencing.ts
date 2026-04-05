/**
 * Grant-sequencing (Plan 0004 subplan 03): enqueue grant inner hash to the same DO as register-signed-statement.
 * No server-side polling: caller returns 303 to status URL; client polls query-registration-status (same endpoint).
 */

import type { SequencingQueueStub } from "@canopy/forestrie-ingress-types";
import { getQueueForLog } from "../sequeue/logshard.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import { grantCommitmentHashToHex } from "../grant/grant-commitment.js";

function contentHashBuffer(inner: Uint8Array): ArrayBuffer {
  return inner.buffer.slice(
    inner.byteOffset,
    inner.byteOffset + inner.byteLength,
  ) as ArrayBuffer;
}

export interface GrantSequencingResult {
  /** Status URL path: /logs/{bootstrapLogId}/{ownerLogId}/entries/{innerHex} (caller prepends origin). */
  statusUrlPath: string;
  /** Lowercase hex inner hash (for storage path and status URL). */
  innerHex: string;
  /** Owner log UUID (authority log). */
  ownerLogIdUuid: string;
  /** True if resolveContent(inner) was already non-null (dedupe; did not enqueue). */
  alreadySequenced: boolean;
}

export interface GrantSequencingEnv {
  sequencingQueue: DurableObjectNamespace;
  shardCountStr: string;
}

/**
 * Dedupe by inner, then enqueue(ownerLogId, inner). Returns status URL path and inner hex for the caller to return 303 and store grant.
 */
export async function enqueueGrantForSequencing(
  ownerLogIdBytes: Uint8Array,
  inner: Uint8Array,
  env: GrantSequencingEnv,
  /** Canonical UUID for bootstrap log id (first path segment under `/logs/`). */
  bootstrapCanonicalLogId: string,
): Promise<GrantSequencingResult> {
  const ownerLogIdUuid = bytesToUuid(ownerLogIdBytes);
  const innerHex = grantCommitmentHashToHex(inner);
  const queue = getQueueForLog(env, ownerLogIdUuid);

  const contentHash = contentHashBuffer(inner);

  const existing = await queue.resolveContent(contentHash);
  if (existing !== null) {
    return {
      statusUrlPath: `/logs/${bootstrapCanonicalLogId}/${ownerLogIdUuid}/entries/${innerHex}`,
      innerHex,
      ownerLogIdUuid,
      alreadySequenced: true,
    };
  }

  const logId16 = new Uint8Array(16);
  const src =
    ownerLogIdBytes.length >= 16 ? ownerLogIdBytes.slice(-16) : ownerLogIdBytes;
  logId16.set(src, 16 - src.length);
  await queue.enqueue(logId16.buffer, contentHash, undefined);

  return {
    statusUrlPath: `/logs/${bootstrapCanonicalLogId}/${ownerLogIdUuid}/entries/${innerHex}`,
    innerHex,
    ownerLogIdUuid,
    alreadySequenced: false,
  };
}
