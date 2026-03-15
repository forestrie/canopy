/**
 * Subplan 08 §3.3.1: Verify grant included in owner log (initial scope).
 *
 * For now we verify inclusion only by checking that the grant has been sequenced:
 * resolveContent(inner) on the SequencingQueue DO for the grant's ownerLogId returns
 * a result. If it does, we treat the grant as included. We know from bootstraping
 * and log hierarchy that the pipeline (arbor log builder) that wrote to the DO
 * included the leaf in the log and signed; that is enough for this initial work.
 *
 * Stronger defence (out of scope here, to be added later):
 * - Evaluate the grant's receipt (proof): use @canopy/merklelog verifyInclusion to
 *   verify the leaf is in the MMR, and verify the receipt's signed statement (COSE
 *   signature from the log builder). Then check grant signer vs new statement
 *   signer in register-signed-statement.
 * - Checkpoint-from-chain or checkpoint-from-storage to prove against a fresh
 *   accumulator; MMR accumulators allow efficient old-receipt vs fresh-checkpoint
 *   proofs but that is deferred.
 *
 * See docs/plans/plan-0004-log-bootstraping/subplan-08-grant-first-bootstrap.md
 */

import { getQueueForLog } from "../sequeue/logshard.js";
import type { Grant } from "../grant/types.js";
import { innerHashFromGrant } from "../grant/inner-hash.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";

/** Env needed to resolve the queue and call resolveContent(inner). */
export interface InclusionEnv {
  sequencingQueue: DurableObjectNamespace;
  shardCountStr: string;
}

function hexToBytes(hex: string): ArrayBuffer {
  const s = hex.replace(/^0x/i, "").trim().toLowerCase();
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

/**
 * Verify grant is included in its owner log.
 * Uses only resolveContent(inner): if the DO returns a result, the grant was
 * sequenced by the pipeline (arbor log builder) and we accept it as included.
 * Receipt-based MMR verification and checkpoint-from-chain/storage are planned
 * for later as stronger defence.
 */
export async function verifyGrantIncluded(
  grant: Grant,
  env: InclusionEnv,
): Promise<boolean> {
  const ownerLogIdBytes = grant.ownerLogId as Uint8Array;
  const ownerLogIdUuid = bytesToUuid(ownerLogIdBytes);

  const inner = await innerHashFromGrant(grant);
  const innerHex = Array.from(inner)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const contentHashBytes = hexToBytes(innerHex);

  const queue = getQueueForLog(env, ownerLogIdUuid);
  const result = await queue.resolveContent(contentHashBytes);

  return result !== null;
}
