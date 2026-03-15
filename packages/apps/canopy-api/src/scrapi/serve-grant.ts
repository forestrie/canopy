/**
 * Serve grant document with lazy completion (Plan 0004 subplan 03).
 * GET /grants/authority/{innerHex} — load grant from R2, resolveContent(inner); if sequenced, merge idtimestamp and return full grant CBOR.
 */

import { getQueueForLog } from "../sequeue/logshard.js";
import { decodeGrantPayload, encodeGrantForResponse } from "../grant/codec.js";
import type { Grant } from "../grant/types.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import { ClientErrors, ServerErrors } from "./problem-details";
import { readIdtimestampFromMassif } from "./sequencing-result.js";

const SEQUENCED_GRANT_KIND_SEGMENT = "authority";

function hexToBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

function writeU64BE(out: Uint8Array, offset: number, value: bigint): void {
  let v = value;
  for (let i = 7; i >= 0; i--) {
    out[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

export interface ServeGrantEnv {
  r2Grants: R2Bucket;
  r2Mmrs: R2Bucket;
  sequencingQueue: DurableObjectNamespace;
  shardCountStr: string;
  massifHeight: number;
}

/**
 * Load grant from R2 at authority/{innerHex}.cbor, resolve sequencing; if complete, merge idtimestamp and return grant CBOR.
 */
export async function serveGrant(
  innerHex: string,
  env: ServeGrantEnv,
): Promise<Response> {
  if (innerHex.length !== 64 || !/^[0-9a-f]+$/i.test(innerHex)) {
    return ClientErrors.badRequest("innerHex must be 64 hex characters");
  }

  const storageKey = `${SEQUENCED_GRANT_KIND_SEGMENT}/${innerHex.toLowerCase()}.cbor`;
  const obj = await env.r2Grants.get(storageKey);
  if (!obj) {
    return ClientErrors.notFound("Grant not found");
  }

  const bytes = new Uint8Array(await obj.arrayBuffer());
  let grant: Grant;
  try {
    grant = decodeGrantPayload(bytes);
  } catch {
    return ServerErrors.internal("Grant decode failed");
  }

  const ownerLogIdUuid = bytesToUuid(grant.ownerLogId);
  const queue = getQueueForLog(env, ownerLogIdUuid);

  const contentHashBytes = hexToBuffer(innerHex.toLowerCase());
  const result = await queue.resolveContent(contentHashBytes);

  if (!result) {
    return new Response(null, {
      status: 202,
      headers: {
        "Retry-After": "5",
        "Content-Type": "application/cbor",
      },
    });
  }

  const idtimestamp = await readIdtimestampFromMassif(
    env.r2Mmrs,
    ownerLogIdUuid,
    env.massifHeight,
    result.massifIndex,
    result.leafIndex,
  );
  const idtimestampBytes = new Uint8Array(8);
  writeU64BE(idtimestampBytes, 0, idtimestamp);

  const encoded = encodeGrantForResponse(grant, idtimestampBytes);
  return new Response(encoded, {
    status: 200,
    headers: {
      "Content-Type": "application/cbor",
      "Content-Length": String(encoded.length),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

/**
 * Fetch a completed grant by path (for register-signed-statement X-Grant-Location).
 *
 * **Context:** When the client sends X-Grant-Location: /grants/authority/{innerHex}, we must return
 * the grant with idtimestamp filled in so that the statement can be validated against the sequenced
 * authority log entry. The grant was stored at enqueue time with a placeholder idtimestamp;
 * sequencing (ranger appending the leaf to the MMR) happens asynchronously.
 *
 * **Transformation:** We load the grant from R2, then (1) resolve sequencing state for this inner
 * hash on the correct queue, (2) read idtimestamp from the massif in R2, and (3) merge idtimestamp
 * into the grant. If the entry is not yet sequenced, resolveContent returns null and we return null.
 *
 * **Shard name → DoId:** The SequencingQueue is sharded by authority log; we use getQueueForLog(env, ownerLogId)
 * so we hit the same DO that enqueue(ownerLogId, inner) used at register-grant time. See src/sequeue/logshard.ts.
 *
 * Design: docs/plans/plan-0004-log-bootstraping/subplan-03-grant-sequencing-component.md
 * (grant-sequencing, same DO as register-signed-statement; resolveContent return path; R2 fallback
 * for idtimestamp when DO does not store it — §7.1).
 */
export async function getCompletedGrant(
  path: string,
  env: ServeGrantEnv,
): Promise<{ grant: Grant; bytes: Uint8Array } | null> {
  const match = /^\/grants\/authority\/([0-9a-f]{64})$/i.exec(path);
  if (!match) return null;

  const innerHex = match[1]!.toLowerCase();
  const storageKey = `${SEQUENCED_GRANT_KIND_SEGMENT}/${innerHex}.cbor`;
  const obj = await env.r2Grants.get(storageKey);
  if (!obj) return null;

  const bytes = new Uint8Array(await obj.arrayBuffer());
  let grant: Grant;
  try {
    grant = decodeGrantPayload(bytes);
  } catch {
    return null;
  }

  const ownerLogIdUuid = bytesToUuid(grant.ownerLogId);
  const queue = getQueueForLog(env, ownerLogIdUuid);

  const contentHashBytes = hexToBuffer(innerHex);
  const result = await queue.resolveContent(contentHashBytes);
  if (!result) return null;

  const idtimestamp = await readIdtimestampFromMassif(
    env.r2Mmrs,
    ownerLogIdUuid,
    env.massifHeight,
    result.massifIndex,
    result.leafIndex,
  );

  const idtimestampBytes = new Uint8Array(8);
  writeU64BE(idtimestampBytes, 0, idtimestamp);

  return {
    grant,
    bytes: encodeGrantForResponse(grant, idtimestampBytes),
  };
}
