/**
 * Grant-sequencing (Plan 0004 subplan 03): enqueue grant inner hash to the same DO as register-signed-statement.
 * No server-side polling: caller returns 303 to status URL; client polls query-registration-status (same endpoint).
 */

import type { SequencingQueueStub } from "@canopy/forestrie-ingress-types";
import { getQueueForLog } from "../sequeue/logshard.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import { grantCommitmentHashToHex } from "../grant/grant-commitment.js";
import type {
  GrantSequencingEnv,
  GrantSequencingResult,
} from "./grant-sequencing-env.js";

export type { GrantSequencingEnv, GrantSequencingResult } from "./types.js";

function contentHashBuffer(inner: Uint8Array): ArrayBuffer {
  return inner.buffer.slice(
    inner.byteOffset,
    inner.byteOffset + inner.byteLength,
  ) as ArrayBuffer;
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
