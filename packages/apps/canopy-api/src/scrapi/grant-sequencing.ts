/**
 * Grant-sequencing (Plan 0004 subplan 03): enqueue grant inner hash to the same DO as register-signed-statement.
 * No server-side polling: caller returns 303 to status URL; client polls query-registration-status (same endpoint).
 */

import type { SequencingQueueStub } from "@canopy/forestrie-ingress-types";
import { getQueueForLog } from "../sequeue/logshard.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import { grantCommitmentHashToHex } from "../grant/grant-commitment.js";

function hexToBytes(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

export interface GrantSequencingResult {
  /** Status URL path: /logs/{ownerLogId}/entries/{innerHex} (caller prepends origin). */
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
): Promise<GrantSequencingResult> {
  const ownerLogIdUuid = bytesToUuid(ownerLogIdBytes);
  const innerHex = grantCommitmentHashToHex(inner);
  const queue = getQueueForLog(env, ownerLogIdUuid);

  const contentHashBytes = hexToBytes(innerHex);

  const existing = await queue.resolveContent(contentHashBytes);
  if (existing !== null) {
    return {
      statusUrlPath: `/logs/${ownerLogIdUuid}/entries/${innerHex}`,
      innerHex,
      ownerLogIdUuid,
      alreadySequenced: true,
    };
  }

  const logId16 = new Uint8Array(16);
  const src =
    ownerLogIdBytes.length >= 16 ? ownerLogIdBytes.slice(-16) : ownerLogIdBytes;
  logId16.set(src, 16 - src.length);
  await queue.enqueue(logId16.buffer, contentHashBytes, undefined);

  return {
    statusUrlPath: `/logs/${ownerLogIdUuid}/entries/${innerHex}`,
    innerHex,
    ownerLogIdUuid,
    alreadySequenced: false,
  };
}
